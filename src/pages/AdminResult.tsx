import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getRaceWithPool, getResult, setRaceResult } from '../lib/db';
import type { Driver, Race } from '../lib/types';
import { SaveError } from '../lib/types';
import { PredictionSlots } from '../components/PredictionSlots';
import { DriverPool } from '../components/DriverPool';

export default function AdminResult() {
  const { raceId } = useParams();
  const nav = useNavigate();
  const [race, setRace] = useState<Race | null>(null);
  const [pool, setPool] = useState<Driver[]>([]);
  const [slots, setSlots] = useState<(string | null)[]>(Array(10).fill(null));
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [hadResult, setHadResult] = useState(false);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const { race, pool } = await getRaceWithPool(Number(raceId));
        const saved = await getResult(Number(raceId));
        setRace(race);
        setPool(pool);
        setHadResult(!!saved);
        setSlots(saved && saved.length === 10 ? saved : Array(10).fill(null));
      } catch (e: any) {
        setErr(e.message || 'Ошибка загрузки');
      } finally {
        setLoading(false);
      }
    })();
  }, [raceId, reload]);

  const driversById = useMemo(() => new Map(pool.map((d) => [d.id, d])), [pool]);
  const assigned = useMemo(() => new Set(slots.filter((x): x is string => !!x)), [slots]);
  const full = slots.every((s) => s !== null);

  function onSlotClick(i: number) {
    if (slots[i]) {
      setSlots((prev) => {
        const next = [...prev];
        next[i] = null;
        return next;
      });
      setSelectedSlot(null);
    } else {
      setSelectedSlot((prev) => (prev === i ? null : i));
    }
  }

  function onPick(driverId: string) {
    setSlots((prev) => {
      const target = selectedSlot !== null ? selectedSlot : prev.indexOf(null);
      if (target === -1 || target === null) return prev;
      const next = [...prev];
      const existing = next.indexOf(driverId);
      if (existing !== -1) next[existing] = null;
      next[target] = driverId;
      return next;
    });
    setSelectedSlot(null);
  }

  async function save() {
    if (!race || !full) return;
    if (new Date(race.deadline_utc) > new Date()) {
      const ok = window.confirm(
        'Дедлайн этой гонки ещё не наступил — гонка в реальности уже прошла? Если нет, отмени и подожди.',
      );
      if (!ok) return;
    }
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await setRaceResult(race.id, slots as string[], hadResult ? reason || undefined : undefined);
      setMsg('Результат сохранён, гонка зачтена');
      setTimeout(() => nav('/admin'), 700);
    } catch (e) {
      setErr(e instanceof SaveError ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="stub">Загрузка…</div>;
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
        <h1>Результат: {race.name}</h1>
        {hadResult && (
          <span className="lock-note">Редактирование перезапишет результат; изменение попадёт в журнал</span>
        )}
      </div>

      <div className="predict-grid">
        <PredictionSlots
          slots={slots}
          driversById={driversById}
          selectedIndex={selectedSlot}
          onSlotClick={onSlotClick}
        />
        <DriverPool pool={pool} assigned={assigned} onPick={onPick} />
      </div>

      {hadResult && (
        <input
          className="reason-input"
          placeholder="причина правки (необязательно)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}

      <div className="predict-actions">
        <button disabled={!full || busy} onClick={save}>{busy ? '…' : 'Сохранить результат'}</button>
        {msg && <span className="ok-note">{msg}</span>}
        {err && <span className="auth-err">{err}</span>}
      </div>
    </div>
  );
}
