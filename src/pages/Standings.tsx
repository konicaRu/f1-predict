import { useCallback, useEffect, useState } from 'react';
import { listRaces, getScores, listUsers } from '../lib/db';
import { aggregateStandings, type StandingRow } from '../lib/standings';
import { supabase } from '../lib/supabase';

export default function Standings() {
  const [rows, setRows] = useState<StandingRow[] | null>(null);
  const [scoredCount, setScoredCount] = useState(0);
  const [meId, setMeId] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    setRows(null);
    try {
      const [races, scores, users, userRes] = await Promise.all([
        listRaces(),
        getScores(),
        listUsers(),
        supabase.auth.getUser(),
      ]);
      const scoredIds = new Set(races.filter((r) => r.scored).map((r) => r.id));
      setScoredCount(scoredIds.size);
      setMeId(userRes.data.user?.id ?? null);
      setRows(aggregateStandings(scores, users, scoredIds));
    } catch (e: any) {
      setErr(e.message || 'Ошибка загрузки');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (err && !rows)
    return (
      <div className="stub">
        <p>{err}</p>
        <button className="retry-btn" onClick={load}>Повторить</button>
      </div>
    );
  if (!rows) return <div className="stub">Загрузка…</div>;
  if (scoredCount === 0) return <div className="stub">Зачёт появится после первой зачётной гонки.</div>;

  return (
    <div className="standings">
      <h1 className="page-h1">Общий зачёт</h1>
      <table className="lb">
        <thead>
          <tr>
            <th>#</th>
            <th>Игрок</th>
            <th>Очки</th>
            <th>Точных</th>
            <th>Лучшая</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.userId}
              className={'lb-row' + (r.userId === meId ? ' lb-me' : '') + (r.rank <= 3 ? ' lb-p' + r.rank : '')}
            >
              <td className="lb-place">{r.rank}</td>
              <td className="lb-name">
                {r.name}
                {r.userId === meId && <span className="lb-you">ты</span>}
              </td>
              <td className="lb-pts">{r.points}</td>
              <td>{r.exact}</td>
              <td>{r.bestRace}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="lb-note">При равенстве очков выше тот, у кого больше точных попаданий, затем — лучшая гонка.</p>
    </div>
  );
}
