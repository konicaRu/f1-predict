import { supabase } from './supabase';
import type { Race, Driver } from './types';
import { SaveError } from './types';

// Сеть до Supabase флапает -> ретрай транзиентных сбоев (обрыв fetch), но НЕ ошибок БД/RLS.
function isTransient(e: unknown): boolean {
  const m = (e as { message?: string })?.message?.toLowerCase?.() || '';
  return /failed to fetch|fetch failed|network|timeout|econn|load failed/.test(m);
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let a = 1; a <= tries; a++) {
    try {
      return await fn();
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
      .select('drivers(id, code, name, team, team_color)')
      .eq('race_id', raceId);
    if (e2) throw e2;
    const pool = (poolRows ?? [])
      .map((r: any) => r.drivers as Driver)
      .filter(Boolean)
      .sort((a, b) => a.code.localeCompare(b.code));
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

export async function nextOpenRace(): Promise<Race | null> {
  const races = await listRaces();
  const now = Date.now();
  const open = races
    .filter((r) => r.status === 'open' && new Date(r.deadline_utc).getTime() >= now)
    .sort((a, b) => new Date(a.deadline_utc).getTime() - new Date(b.deadline_utc).getTime());
  return open[0] ?? null;
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
