import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getRaceWithPool, getMyPrediction, savePrediction, nextOpenRace, getVotedUserIds, listUsers } from '../lib/db';
import type { Driver, Race, LeagueUser } from '../lib/types';
import { SaveError } from '../lib/types';
import { isPast, formatCountdown } from '../lib/countdown';
import { PredictionSlots } from '../components/PredictionSlots';
import { DriverPool } from '../components/DriverPool';

export default function Predict() {
  const { raceId } = useParams();
  const nav = useNavigate();
  const [race, setRace] = useState<Race | null>(null);
  const [pool, setPool] = useState<Driver[]>([]);
  const [slots, setSlots] = useState<(string | null)[]>(Array(10).fill(null));
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [leagueUsers, setLeagueUsers] = useState<LeagueUser[]>([]);
  const [votedIds, setVotedIds] = useState<string[]>([]);

  // /predict без id -> редирект на ближайшую открытую гонку
  useEffect(() => {
    if (raceId) return;
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const r = await nextOpenRace();
        if (r) nav(`/predict/${r.id}`, { replace: true });
        else setLoading(false);
      } catch (e: any) {
        setErr(e.message || 'Ошибка загрузки');
        setLoading(false);
      }
    })();
  }, [raceId, nav, reload]);

  useEffect(() => {
    if (!raceId) return;
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const { race, pool } = await getRaceWithPool(Number(raceId));
        const saved = await getMyPrediction(Number(raceId));
        const users = await listUsers();
        const voted = await getVotedUserIds(Number(raceId));
        setRace(race);
        setPool(pool);
        setSlots(saved && saved.length === 10 ? saved : Array(10).fill(null));
        setLeagueUsers(users);
        setVotedIds(voted);
      } catch (e: any) {
        setErr(e.message || 'Ошибка загрузки');
      } finally {
        setLoading(false);
      }
    })();
  }, [raceId, reload]);

  const driversById = useMemo(() => new Map(pool.map((d) => [d.id, d])), [pool]);
  const assigned = useMemo(() => new Set(slots.filter((x): x is string => !!x)), [slots]);
  const readOnly = race ? isPast(race.deadline_utc) : false;
  const full = slots.every((s) => s !== null);
  const votedNames = useMemo(() => {
    const voted = new Set(votedIds);
    return leagueUsers
      .filter((u) => voted.has(u.id))
      .map((u) => u.display_name)
      .sort((a, b) => a.localeCompare(b));
  }, [leagueUsers, votedIds]);

  function onSlotClick(i: number) {
    if (readOnly) return;
    if (slots[i]) {
      // занятый -> освободить
      setSlots((prev) => {
        const next = [...prev];
        next[i] = null;
        return next;
      });
      setSelectedSlot(null);
    } else {
      // пустой -> выбрать/снять выбор для прицельного размещения
      setSelectedSlot((prev) => (prev === i ? null : i));
    }
  }

  function onPick(driverId: string) {
    if (readOnly) return;
    setSlots((prev) => {
      const target = selectedSlot !== null ? selectedSlot : prev.indexOf(null);
      if (target === -1 || target === null) return prev;
      const next = [...prev];
      const existing = next.indexOf(driverId);
      if (existing !== -1) next[existing] = null; // защита от дубля
      next[target] = driverId;
      return next;
    });
    setSelectedSlot(null);
  }

  async function save() {
    if (!race || !full) return;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await savePrediction(race.id, slots as string[]);
      setMsg('Прогноз сохранён');
      // Обновление списка проголосовавших — best-effort: сам прогноз уже сохранён,
      // сбой здесь не должен показывать пользователю ложную ошибку сохранения.
      try {
        setVotedIds(await getVotedUserIds(race.id));
      } catch {
        // список подтянется при следующей загрузке страницы
      }
    } catch (e) {
      setErr(e instanceof SaveError ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="stub">Загрузка…</div>;
  if (!raceId) return <div className="stub">Сейчас нет открытых гонок — смотри Календарь.</div>;
  if (err && !race)
    return (
      <div className="stub">
        <p>{err}</p>
        <button className="retry-btn" onClick={() => setReload((n) => n + 1)}>Повторить</button>
      </div>
    );
  if (!race) return <div className="stub">Загрузка…</div>;

  return (
    <div className="predict">
      <div className="predict-head">
        <h1>{race.name}</h1>
        {readOnly ? (
          <span className="lock-note">Дедлайн прошёл — прогноз зафиксирован</span>
        ) : (
          <span className="race-cd">⏱ до дедлайна: {formatCountdown(race.deadline_utc)}</span>
        )}
        {votedNames.length > 0 && (
          <p className="predict-voted">✓ Поставили: {votedNames.join(', ')}</p>
        )}
      </div>

      <div className="predict-grid">
        <PredictionSlots
          slots={slots}
          driversById={driversById}
          selectedIndex={selectedSlot}
          onSlotClick={onSlotClick}
          readOnly={readOnly}
        />
        {!readOnly && <DriverPool pool={pool} assigned={assigned} onPick={onPick} />}
      </div>

      {!readOnly && (
        <div className="predict-actions">
          <button disabled={!full || busy} onClick={save}>{busy ? '…' : 'Сохранить'}</button>
          {msg && <span className="ok-note">{msg}</span>}
          {err && <span className="auth-err">{err}</span>}
        </div>
      )}

      {readOnly && !slots.some(Boolean) && (
        <p className="stub">Ты не делал прогноз на эту гонку.</p>
      )}
    </div>
  );
}
