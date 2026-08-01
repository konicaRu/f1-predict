import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listRaces, openRace, getGuestAccessEnabled, setGuestAccessEnabled } from '../lib/db';
import type { Race } from '../lib/types';
import { isPast } from '../lib/countdown';
import { raceCountry } from '../lib/flags';
import { Flag } from '../components/Flag';

export default function Admin() {
  const [races, setRaces] = useState<Race[] | null>(null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [guestOn, setGuestOn] = useState<boolean | null>(null);
  const [guestBusy, setGuestBusy] = useState(false);
  const nav = useNavigate();

  const load = useCallback(async () => {
    setErr('');
    setRaces(null);
    try {
      setRaces(await listRaces());
    } catch (e: any) {
      setErr(e.message || 'Ошибка загрузки');
      return;
    }
    try {
      setGuestOn(await getGuestAccessEnabled());
    } catch {
      // non-fatal: guest-toggle status failing shouldn't block the race-admin view
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onOpen(id: number) {
    setBusyId(id);
    setErr('');
    try {
      await openRace(id);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Не удалось открыть гонку');
    } finally {
      setBusyId(null);
    }
  }

  async function onToggleGuest() {
    if (guestOn === null) return;
    setGuestBusy(true);
    setErr('');
    try {
      await setGuestAccessEnabled(!guestOn);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Не удалось переключить гостевой доступ');
    } finally {
      setGuestBusy(false);
    }
  }

  if (err && !races)
    return (
      <div className="stub">
        <p>{err}</p>
        <button className="retry-btn" onClick={load}>Повторить</button>
      </div>
    );
  if (!races) return <div className="stub">Загрузка…</div>;

  return (
    <div className="admin">
      <h1 className="admin-h1">Админка</h1>
      {err && <p className="auth-err">{err}</p>}
      <div className="admin-row">
        <div className="admin-race">
          <span className="race-name">Гостевой доступ (read-only, без аккаунта)</span>
        </div>
        <div className="admin-actions">
          <button disabled={guestOn === null || guestBusy} onClick={onToggleGuest}>
            {guestBusy ? '…' : guestOn ? 'Выключить' : 'Включить'}
          </button>
          <span className="admin-badge">{guestOn === null ? '…' : guestOn ? 'включён' : 'выключен'}</span>
        </div>
      </div>
      <div className="admin-list">
        {races.map((r) => {
          const upcoming = r.status === 'demo' && !isPast(r.deadline_utc);
          const opened = r.status === 'open';
          const resulted = r.status === 'resulted';
          const dim = r.status === 'demo' && isPast(r.deadline_utc);
          return (
            <div key={r.id} className={'admin-row' + (dim ? ' admin-dim' : '')}>
              <div className="admin-race">
                <span className="race-round">R{r.round}</span>
                <Flag code={raceCountry(r.name)} />
                <span className="race-name">{r.name}</span>
              </div>
              <div className="admin-actions">
                {upcoming && (
                  <button disabled={busyId === r.id} onClick={() => onOpen(r.id)}>
                    {busyId === r.id ? '…' : 'Открыть гонку'}
                  </button>
                )}
                {opened && (
                  <button onClick={() => nav(`/admin/result/${r.id}`)}>Занести результат</button>
                )}
                {resulted && (
                  <>
                    <button onClick={() => nav(`/admin/result/${r.id}`)}>✏ Редактировать результат</button>
                    <span className="admin-badge">результат ✓</span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
