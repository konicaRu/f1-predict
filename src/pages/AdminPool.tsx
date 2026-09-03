import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getRaceWithPool, listDrivers, addDriverToPool, setDriverOutReason } from '../lib/db';
import type { Driver, Race } from '../lib/types';

export default function AdminPool() {
  const { raceId } = useParams();
  const nav = useNavigate();
  const [race, setRace] = useState<Race | null>(null);
  const [pool, setPool] = useState<Driver[]>([]);
  const [allDrivers, setAllDrivers] = useState<Driver[]>([]);
  const [addId, setAddId] = useState('');
  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const [{ race, pool }, drivers] = await Promise.all([
          getRaceWithPool(Number(raceId)),
          listDrivers(),
        ]);
        setRace(race);
        setPool(pool);
        setAllDrivers(drivers);
      } catch (e: any) {
        setErr(e.message || 'Ошибка загрузки');
      } finally {
        setLoading(false);
      }
    })();
  }, [raceId, reload]);

  const poolIds = new Set(pool.map((d) => d.id));
  const candidates = allDrivers.filter((d) => !poolIds.has(d.id));

  async function onAdd() {
    if (!race || !addId) return;
    const targetId = addId;
    setBusyId(targetId);
    setErr('');
    setMsg('');
    try {
      await addDriverToPool(race.id, targetId);
      setMsg('Пилот добавлен в пул');
      setAddId('');
      setReload((n) => n + 1);
    } catch (e: any) {
      setErr(e.message || 'Не удалось добавить');
    } finally {
      setBusyId((cur) => (cur === targetId ? null : cur));
    }
  }

  async function onMarkOut(driverId: string) {
    if (!race) return;
    const reason = (reasonDrafts[driverId] || '').trim();
    if (!reason) return;
    setBusyId(driverId);
    setErr('');
    setMsg('');
    try {
      await setDriverOutReason(race.id, driverId, reason);
      setMsg('Пилот помечен как не участвует');
      setReload((n) => n + 1);
    } catch (e: any) {
      setErr(e.message || 'Не удалось сохранить');
    } finally {
      setBusyId((cur) => (cur === driverId ? null : cur));
    }
  }

  async function onClearOut(driverId: string) {
    if (!race) return;
    setBusyId(driverId);
    setErr('');
    try {
      await setDriverOutReason(race.id, driverId, null);
      setReload((n) => n + 1);
    } catch (e: any) {
      setErr(e.message || 'Не удалось снять пометку');
    } finally {
      setBusyId((cur) => (cur === driverId ? null : cur));
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
    <div className="admin">
      <h1 className="admin-h1">Состав пилотов: {race.name}</h1>
      {err && <p className="auth-err">{err}</p>}
      {msg && <p className="ok-note">{msg}</p>}

      <div className="admin-list">
        {pool.map((d) => (
          <div key={d.id} className="admin-row">
            <div className="admin-race">
              <span className="race-name">{d.code} — {d.name}</span>
              {d.out_reason && <span className="chip-dnf">DNF</span>}
            </div>
            <div className="admin-actions">
              {d.out_reason ? (
                <>
                  <span className="lock-note">{d.out_reason}</span>
                  <button disabled={busyId === d.id} onClick={() => onClearOut(d.id)}>
                    {busyId === d.id ? '…' : 'Снять пометку'}
                  </button>
                </>
              ) : (
                <>
                  <input
                    className="reason-input"
                    placeholder="причина (напр. травма)"
                    value={reasonDrafts[d.id] || ''}
                    onChange={(e) => setReasonDrafts((prev) => ({ ...prev, [d.id]: e.target.value }))}
                  />
                  <button
                    disabled={busyId === d.id || !(reasonDrafts[d.id] || '').trim()}
                    onClick={() => onMarkOut(d.id)}
                  >
                    {busyId === d.id ? '…' : 'Пометить как не участвует'}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="admin-row">
        <div className="admin-race">
          <select value={addId} onChange={(e) => setAddId(e.target.value)}>
            <option value="">Выбери пилота…</option>
            {candidates.map((d) => (
              <option key={d.id} value={d.id}>{d.code} — {d.name}</option>
            ))}
          </select>
        </div>
        <div className="admin-actions">
          <button disabled={!addId || busyId === addId} onClick={onAdd}>
            {busyId === addId ? '…' : 'Добавить в пул'}
          </button>
        </div>
      </div>

      <button className="retry-btn" onClick={() => nav('/admin')}>Назад в Админку</button>
    </div>
  );
}
