import { useCallback, useEffect, useMemo, useState } from 'react';
import { listRaces, getResult, getScores, listUsers, listDrivers, getPrediction } from '../lib/db';
import type { Race, Driver, Score, LeagueUser } from '../lib/types';
import { supabase } from '../lib/supabase';
import DriftChart from '../components/DriftChart';

export default function Results() {
  const [races, setRaces] = useState<Race[] | null>(null);
  const [drivers, setDrivers] = useState<Map<string, Driver>>(new Map());
  const [users, setUsers] = useState<Map<string, string>>(new Map());
  const [leagueUsers, setLeagueUsers] = useState<LeagueUser[]>([]);
  const [scores, setScores] = useState<Score[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [selPlayer, setSelPlayer] = useState<string | null>(null);
  const [positions, setPositions] = useState<string[] | null>(null);
  const [prediction, setPrediction] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setErr('');
    setLoading(true);
    try {
      const [rs, ds, us, sc, userRes] = await Promise.all([
        listRaces(),
        listDrivers(),
        listUsers(),
        getScores(),
        supabase.auth.getUser(),
      ]);
      setRaces(rs);
      setDrivers(new Map(ds.map((d) => [d.id, d])));
      setUsers(new Map(us.map((u) => [u.id, u.display_name])));
      setLeagueUsers(us);
      setScores(sc);
      const me = userRes.data.user?.id ?? null;
      setMeId(me);
      setSelPlayer(me);
      const resulted = rs.filter((r) => r.status === 'resulted').sort((a, b) => b.round - a.round);
      setSel(resulted[0]?.id ?? null);
    } catch (e: any) {
      setErr(e.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (sel == null) {
      setPositions(null);
      return;
    }
    getResult(sel).then(setPositions).catch(() => setPositions(null));
  }, [sel]);

  useEffect(() => {
    if (sel == null || selPlayer == null) {
      setPrediction(null);
      return;
    }
    getPrediction(sel, selPlayer).then(setPrediction).catch(() => setPrediction(null));
  }, [sel, selPlayer]);

  const resulted = useMemo(
    () => (races ?? []).filter((r) => r.status === 'resulted').sort((a, b) => b.round - a.round),
    [races],
  );
  const raceScores = useMemo(
    () => scores.filter((s) => s.race_id === sel).sort((a, b) => b.points - a.points),
    [scores, sel],
  );
  const selRace = useMemo(() => resulted.find((r) => r.id === sel) ?? null, [resulted, sel]);
  const selPlayerScore = useMemo(
    () => raceScores.find((s) => s.user_id === selPlayer) ?? null,
    [raceScores, selPlayer],
  );

  if (err && !races)
    return (
      <div className="stub">
        <p>{err}</p>
        <button className="retry-btn" onClick={load}>Повторить</button>
      </div>
    );
  if (loading || !races) return <div className="stub">Загрузка…</div>;
  if (resulted.length === 0)
    return <div className="stub">Результатов пока нет — появятся после первой сыгранной гонки.</div>;

  return (
    <div className="results">
      <h1 className="page-h1">Результаты</h1>
      <div className="race-pills">
        {resulted.map((r) => (
          <button
            key={r.id}
            className={'pill' + (r.id === sel ? ' pill-on' : '')}
            onClick={() => setSel(r.id)}
          >
            R{r.round} · {r.name.replace(' Grand Prix', '')}
          </button>
        ))}
      </div>
      <div className="results-grid">
        <div className="res-top10">
          <h2 className="col-h">Финиш · топ-10</h2>
          <ol className="finish">
            {(positions ?? []).map((id, i) => {
              const d = drivers.get(id);
              return (
                <li key={id} className={'finish-row' + (i < 3 ? ' finish-podium' : '')}>
                  <span className="finish-pos">{i + 1}</span>
                  <span className="finish-bar" style={{ background: d?.team_color || '#888' }} />
                  <span className="finish-code">{d?.code ?? id}</span>
                  <span className="finish-name">{d?.name ?? ''}</span>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="res-scores">
          <h2 className="col-h">Очки за гонку</h2>
          <table className="lb">
            <thead>
              <tr>
                <th>Игрок</th>
                <th>Очки</th>
                <th>Точных</th>
              </tr>
            </thead>
            <tbody>
              {raceScores.map((s) => (
                <tr key={s.user_id} className={'lb-row' + (s.user_id === meId ? ' lb-me' : '')}>
                  <td className="lb-name">
                    {users.get(s.user_id) ?? '—'}
                    {s.user_id === meId && <span className="lb-you">ты</span>}
                  </td>
                  <td className="lb-pts">{s.points}</td>
                  <td>{s.exact_hits}</td>
                </tr>
              ))}
              {raceScores.length === 0 && (
                <tr>
                  <td colSpan={3} className="lb-empty">Нет прогнозов на эту гонку</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <h2 className="col-h">Игрок</h2>
      <div className="race-pills">
        {leagueUsers.map((u) => (
          <button
            key={u.id}
            className={'pill' + (u.id === selPlayer ? ' pill-on' : '')}
            onClick={() => setSelPlayer(u.id)}
          >
            {u.display_name}{u.id === meId ? ' (ты)' : ''}
          </button>
        ))}
      </div>
      {selRace && selPlayer && (
        <DriftChart
          prediction={prediction}
          actual={positions ?? []}
          drivers={drivers}
          playerName={users.get(selPlayer) ?? '—'}
          raceName={selRace.name}
          points={selPlayerScore?.points ?? 0}
          exactHits={selPlayerScore?.exact_hits ?? 0}
        />
      )}
    </div>
  );
}
