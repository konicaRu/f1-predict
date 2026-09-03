import { supabase } from './supabase';
import type { Race, Driver, Score, LeagueUser } from './types';
import { SaveError } from './types';

// Сеть до Supabase флапает -> ретрай транзиентных сбоев (обрыв fetch), но НЕ ошибок БД/RLS.
function isTransient(e: unknown): boolean {
  const m = (e as { message?: string })?.message?.toLowerCase?.() || '';
  return /failed to fetch|fetch failed|network|timeout|econn|load failed/.test(m);
}

// У supabase-js нет таймаута на fetch: зависший коннект не падает и висит вечно.
// Ограничиваем ожидание -> зависание становится transient-ошибкой -> ретраится.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('network timeout')), ms)),
  ]);
}

export async function withRetry<T>(fn: () => Promise<T>, tries = 3, timeoutMs = 10000): Promise<T> {
  let last: unknown;
  for (let a = 1; a <= tries; a++) {
    try {
      return await withTimeout(fn(), timeoutMs);
    } catch (e) {
      last = e;
      if (a === tries || !isTransient(e)) throw e;
      await new Promise((r) => setTimeout(r, 400 * a));
    }
  }
  throw last;
}

export async function listRaces(): Promise<Race[]> {
  return withRetry(async () => {
    const { data, error } = await supabase
      .from('races').select('*').eq('season', 2026).order('round');
    if (error) throw error;
    return (data ?? []) as Race[];
  });
}

export async function getMyPredictionRaceIds(): Promise<Set<number>> {
  return withRetry(async () => {
    const { data, error } = await supabase.from('predictions').select('race_id');
    if (error) throw error;
    return new Set((data ?? []).map((r: { race_id: number }) => r.race_id));
  });
}

export async function getRaceWithPool(raceId: number): Promise<{ race: Race; pool: Driver[] }> {
  return withRetry(async () => {
    const { data: race, error: e1 } = await supabase
      .from('races').select('*').eq('id', raceId).single();
    if (e1) throw e1;
    const { data: poolRows, error: e2 } = await supabase
      .from('race_driver_pool')
      .select('out_reason, added_reason, drivers(id, code, name, team, team_color, standing)')
      .eq('race_id', raceId);
    if (e2) throw e2;
    // Порядок как в чемпионате: по позиции (standing), безпозиционные — в конец, затем по коду.
    const pool = (poolRows ?? [])
      .map((r: any) =>
        r.drivers ? ({ ...r.drivers, out_reason: r.out_reason, added_reason: r.added_reason } as Driver) : null,
      )
      .filter((d): d is Driver => !!d)
      .sort((a, b) => {
        const sa = a.standing ?? 999;
        const sb = b.standing ?? 999;
        return sa !== sb ? sa - sb : a.code.localeCompare(b.code);
      });
    return { race: race as Race, pool };
  });
}

export async function getMyPrediction(raceId: number): Promise<string[] | null> {
  return withRetry(async () => {
    const { data, error } = await supabase
      .from('predictions').select('positions').eq('race_id', raceId).maybeSingle();
    if (error) throw error;
    return data ? (data.positions as string[]) : null;
  });
}

// Прогноз конкретного игрока на гонку (для drift chart на экране "Результаты").
// RLS: pred_select_after_deadline открывает чужие прогнозы после дедлайна —
// для resulted-гонок дедлайн всегда уже прошёл, так что это всегда читаемо.
export async function getPrediction(raceId: number, userId: string): Promise<string[] | null> {
  return withRetry(async () => {
    const { data, error } = await supabase
      .from('predictions').select('positions').eq('race_id', raceId).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data ? (data.positions as string[]) : null;
  });
}

// Кто уже сделал прогноз на гонку (только user_id, не positions) — для вкладки "Прогноз".
// RPC security definer обходит построчное RLS-скрытие чужих прогнозов узко и осознанно
// (см. supabase/migrations/0012_predicted_user_ids.sql) — сам прогноз остаётся скрытым.
export async function getVotedUserIds(raceId: number): Promise<string[]> {
  return withRetry(async () => {
    const { data, error } = await supabase.rpc('predicted_user_ids', { p_race_id: raceId });
    if (error) throw error;
    return (data ?? []) as string[];
  });
}

export async function nextOpenRace(): Promise<Race | null> {
  const races = await listRaces();
  const now = Date.now();
  const open = races
    .filter((r) => r.status === 'open' && new Date(r.deadline_utc).getTime() >= now)
    .sort((a, b) => new Date(a.deadline_utc).getTime() - new Date(b.deadline_utc).getTime());
  return open[0] ?? null;
}

export async function redeemInvite(code: string, displayName: string): Promise<void> {
  return withRetry(async () => {
    const { error } = await supabase.rpc('redeem_invite', { p_code: code, p_display_name: displayName });
    if (error) throw error;
  });
}

export async function savePrediction(raceId: number, driverIds: string[]): Promise<void> {
  const { data: userRes } = await supabase.auth.getUser();
  const uid = userRes.user?.id;
  if (!uid) throw new SaveError('unknown', 'Не авторизован');
  try {
    await withRetry(async () => {
      const { error } = await supabase
        .from('predictions')
        .upsert({ user_id: uid, race_id: raceId, positions: driverIds }, { onConflict: 'user_id,race_id' });
      if (error) throw error; // транзиентную сеть ретраит withRetry; ошибки БД/RLS пробрасываются
    });
  } catch (e) {
    throw mapSaveError(e as { message?: string; code?: string });
  }
}

function mapSaveError(error: { message?: string; code?: string }): SaveError {
  const m = (error.message || '').toLowerCase();
  if (error.code === '42501' || m.includes('row-level security'))
    return new SaveError('deadline', 'Дедлайн прошёл — прогноз больше нельзя изменить');
  if (m.includes('exactly 10') || m.includes('10 distinct'))
    return new SaveError('shape', 'Нужно заполнить все 10 мест разными пилотами');
  if (m.includes('race pool'))
    return new SaveError('pool', 'Пилот не из состава этой гонки (обнови страницу)');
  return new SaveError('unknown', 'Не удалось сохранить, попробуй ещё раз');
}

// ===== Админ (Фаза 2c) =====

// Открыть гонку (снимок пула + status=open). open_race идемпотентна -> withRetry (таймаут+ретрай).
export async function openRace(raceId: number): Promise<number> {
  return withRetry(async () => {
    const { data, error } = await supabase.rpc('open_race', { p_race_id: raceId });
    if (error) throw error;
    return data as number;
  });
}

// Текущий результат гонки (топ-10 driver_id) или null.
export async function getResult(raceId: number): Promise<string[] | null> {
  return withRetry(async () => {
    const { data, error } = await supabase
      .from('results').select('positions').eq('race_id', raceId).maybeSingle();
    if (error) throw error;
    return data ? (data.positions as string[]) : null;
  });
}

// Занос/правка результата. Таймаут есть, но БЕЗ ретрая: журнал не идемпотентен
// (повтор при флапе = лишняя строка в result_changes). Зависание -> ошибка -> UI покажет её.
export async function setRaceResult(raceId: number, driverIds: string[], reason?: string): Promise<void> {
  const { error } = await withTimeout(
    (async () =>
      supabase.rpc('set_race_result', {
        p_race_id: raceId, p_positions: driverIds, p_reason: reason ?? null,
      }))(),
    10000,
  );
  if (error) throw mapResultError(error);
}

function mapResultError(error: { message?: string; code?: string }): SaveError {
  const m = (error.message || '').toLowerCase();
  if (m.includes('admin only') || error.code === '42501' || m.includes('row-level security'))
    return new SaveError('admin', 'Только для администратора');
  if (m.includes('exactly 10') || m.includes('10 distinct'))
    return new SaveError('shape', 'Нужно 10 разных пилотов');
  if (m.includes('race pool'))
    return new SaveError('pool', 'Пилот не из состава гонки (обнови страницу)');
  return new SaveError('unknown', 'Не удалось сохранить, попробуй ещё');
}

// ===== Витрина (Фаза 3) =====

// Очки: все видимые строки view scores (RLS: чужое до дедлайна скрыто, для сыгранных — видно).
export async function getScores(): Promise<Score[]> {
  return withRetry(async () => {
    const { data, error } = await supabase.from('scores').select('user_id, race_id, points, exact_hits');
    if (error) throw error;
    return (data ?? []) as Score[];
  });
}

// Игроки лиги (для имён в таблицах).
export async function listUsers(): Promise<LeagueUser[]> {
  return withRetry(async () => {
    const { data, error } = await supabase.from('users').select('id, display_name');
    if (error) throw error;
    return (data ?? []) as LeagueUser[];
  });
}

// Все пилоты (для кодов/цветов команд в топ-10 результата).
export async function listDrivers(): Promise<Driver[]> {
  return withRetry(async () => {
    const { data, error } = await supabase.from('drivers').select('id, code, name, team, team_color, standing');
    if (error) throw error;
    return (data ?? []) as Driver[];
  });
}

// ===== Состав пилотов гонки (правка вручную из Админки, замена SQL-костыля) =====

// Best-effort: у браузера нет TELEGRAM_BOT_TOKEN, поэтому сообщение шлёт Edge Function admin-notify
// (тот же паттерн, что уже используют триггеры registration/prediction/result). Сбой уведомления не
// должен ронять сохранение состава — только выводится в консоль для отладки.
async function notifyPoolChange(payload: {
  race_id: number;
  driver_id: string;
  action: 'added' | 'out';
  reason?: string;
}): Promise<void> {
  try {
    await supabase.functions.invoke('admin-notify', {
      body: { event_type: 'pool_change', payload },
      timeout: 8000,
    });
  } catch (e) {
    console.warn('notifyPoolChange: не удалось отправить уведомление', e);
  }
}

export async function addDriverToPool(raceId: number, driverId: string, reason?: string): Promise<void> {
  await withRetry(async () => {
    const { error } = await supabase
      .from('race_driver_pool')
      .insert({ race_id: raceId, driver_id: driverId, added_reason: reason || null });
    if (error) throw error;
  });
  await notifyPoolChange({ race_id: raceId, driver_id: driverId, action: 'added', reason });
}

export async function setDriverOutReason(raceId: number, driverId: string, reason: string | null): Promise<void> {
  await withRetry(async () => {
    const { error } = await supabase
      .from('race_driver_pool')
      .update({ out_reason: reason })
      .eq('race_id', raceId)
      .eq('driver_id', driverId);
    if (error) throw error;
  });
  if (reason) {
    await notifyPoolChange({ race_id: raceId, driver_id: driverId, action: 'out', reason });
  }
}

// ===== Гостевой доступ (read-only без аккаунта, Фаза 6) =====

export async function getGuestAccessEnabled(): Promise<boolean> {
  return withRetry(async () => {
    const { data, error } = await supabase.rpc('guest_access_enabled');
    if (error) throw error;
    return data as boolean;
  });
}

// Без ретрая — мутирующий вызов, как setRaceResult (повтор при флапе не идемпотентен по смыслу UX).
export async function setGuestAccessEnabled(enabled: boolean): Promise<void> {
  const { error } = await withTimeout(
    (async () => supabase.rpc('set_guest_access', { p_enabled: enabled }))(),
    10000,
  );
  if (error) throw error;
}
