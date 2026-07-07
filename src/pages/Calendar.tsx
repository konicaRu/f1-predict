import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listRaces, getMyPredictionRaceIds } from '../lib/db';
import type { Race } from '../lib/types';
import { RaceCard, classifyRace, type RaceView } from '../components/RaceCard';

export default function Calendar() {
  const [races, setRaces] = useState<Race[] | null>(null);
  const [predIds, setPredIds] = useState<Set<number>>(new Set());
  const [err, setErr] = useState('');
  const nav = useNavigate();

  const load = useCallback(async () => {
    setErr('');
    setRaces(null);
    try {
      const [rs, ids] = await Promise.all([listRaces(), getMyPredictionRaceIds()]);
      setRaces(rs);
      setPredIds(ids);
    } catch (e: any) {
      setErr(e.message || 'Ошибка загрузки');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (err)
    return (
      <div className="stub">
        <p>{err}</p>
        <button className="retry-btn" onClick={load}>Повторить</button>
      </div>
    );
  if (!races) return <div className="stub">Загрузка…</div>;

  const byView = (v: RaceView | RaceView[]) => {
    const set = Array.isArray(v) ? v : [v];
    return races.filter((r) => set.includes(classifyRace(r)));
  };
  const open = byView('open');
  const soon = byView('soon');
  const past = byView(['locked', 'past']);
  const nextOpenId = [...open]
    .sort((a, b) => new Date(a.deadline_utc).getTime() - new Date(b.deadline_utc).getTime())[0]?.id;

  const section = (title: string, list: Race[]) =>
    list.length > 0 && (
      <section className="cal-sec" key={title}>
        <h2 className="cal-h">{title}</h2>
        {list.map((r) => (
          <RaceCard
            key={r.id}
            race={r}
            hasPrediction={predIds.has(r.id)}
            highlight={r.id === nextOpenId}
            onClick={() => nav(`/predict/${r.id}`)}
          />
        ))}
      </section>
    );

  return (
    <div className="calendar">
      {section('Активные', open)}
      {section('Ближайшие', soon)}
      {section('Прошедшие', past)}
    </div>
  );
}
