import { useCallback, useEffect, useState } from 'react';
import { listRaces } from '../lib/db';
import type { Race } from '../lib/types';
import { RaceCard, classifyRace, type RaceView } from '../components/RaceCard';

export default function GuestCalendar() {
  const [races, setRaces] = useState<Race[] | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    setRaces(null);
    try {
      setRaces(await listRaces());
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

  const section = (title: string, list: Race[]) =>
    list.length > 0 && (
      <section className="cal-sec" key={title}>
        <h2 className="cal-h">{title}</h2>
        {list.map((r) => (
          <RaceCard key={r.id} race={r} hasPrediction={false} />
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
