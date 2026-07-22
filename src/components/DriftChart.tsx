import { useEffect, useMemo, useRef, useState } from 'react';
import type { Driver } from '../lib/types';
import { scoreDriftSlots, type DriftSlot } from '../lib/scoring';

const WIDTH = 560;
const ROW_H = 32;
const TOP = 36;
const MISS_ROW_H = 24;
const LEFT_X = 150;
const RIGHT_X = 410;

const ACCURACY_COLOR: Record<DriftSlot['accuracy'], string> = {
  exact: '#4ade80',
  near: '#00E5FF',
  close: '#E8C15A',
  miss: '#5a6273',
};

interface DriftChartProps {
  prediction: string[] | null;
  actual: string[];
  drivers: Map<string, Driver>;
  playerName: string;
  raceName: string;
  points: number;
  exactHits: number;
}

export default function DriftChart({
  prediction, actual, drivers, playerName, raceName, points, exactHits,
}: DriftChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [explainOpen, setExplainOpen] = useState(false);
  const slots = useMemo(
    () => (prediction ? scoreDriftSlots(prediction, actual) : []),
    [prediction, actual],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !prediction) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Промахи (actualPos === null) не могут занимать строки 1-10 — та же строка
    // может понадобиться другому слоту с реальной (пусть и нулевой по очкам) позицией.
    // Уводим их в отдельную полосу под основной сеткой, с уникальным рангом каждому.
    const missCodes = slots.filter((s) => s.actualPos === null).map((s) => s.code);
    const missRank = new Map(missCodes.map((code, idx) => [code, idx]));
    const missLaneHeight = missCodes.length > 0 ? 16 + missCodes.length * MISS_ROW_H : 8;
    const HEIGHT = TOP + ROW_H * 10 + missLaneHeight;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    ctx.font = '700 12px "Titillium Web", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#00E5FF';
    ctx.fillText('ПРОГНОЗ', LEFT_X, 18);
    ctx.fillStyle = '#FF2E63';
    ctx.fillText('ФАКТ', RIGHT_X, 18);

    const cpX = (LEFT_X + RIGHT_X) / 2;

    slots.forEach((slot, i) => {
      const yLeft = TOP + i * ROW_H + ROW_H / 2;
      const yRight = slot.actualPos !== null
        ? TOP + (slot.actualPos - 1) * ROW_H + ROW_H / 2
        : TOP + ROW_H * 10 + 16 + (missRank.get(slot.code) ?? 0) * MISS_ROW_H + MISS_ROW_H / 2;
      const color = ACCURACY_COLOR[slot.accuracy];
      const driver = drivers.get(slot.code);
      const dotColor = driver?.team_color || '#888';

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(slot.accuracy === 'miss' ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(LEFT_X, yLeft);
      ctx.bezierCurveTo(cpX, yLeft, cpX, yRight, RIGHT_X, yRight);
      ctx.stroke();
      ctx.setLineDash([]);

      // Подпись очков — у своей строки прогноза слева (строки гарантированно разнесены на ROW_H),
      // а не у центра кривой: там подписи соседних слотов схлопываются при пересечении линий.
      ctx.fillStyle = color;
      ctx.font = '700 11px "Titillium Web", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(slot.points > 0 ? `+${slot.points}` : '0', LEFT_X + 12, yLeft - 10);

      ctx.fillStyle = dotColor;
      ctx.beginPath();
      ctx.arc(LEFT_X, yLeft, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e8ebf2';
      ctx.font = '700 12px "Titillium Web", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText((driver?.code ?? slot.code).toUpperCase(), LEFT_X - 14, yLeft + 4);
      ctx.fillStyle = '#8A93A6';
      ctx.font = '600 10px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`P${slot.predictedPos}`, 12, yLeft + 4);

      if (slot.actualPos !== null) {
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(RIGHT_X, yRight, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#e8ebf2';
        ctx.font = '700 12px "Titillium Web", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`${(driver?.code ?? slot.code).toUpperCase()} · P${slot.actualPos}`, RIGHT_X + 14, yRight + 4);
      } else {
        ctx.strokeStyle = '#5a6273';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(RIGHT_X, yRight, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#5a6273';
        ctx.font = '600 11px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('мимо топ-10', RIGHT_X + 14, yRight + 4);
      }
    });
  }, [prediction, slots, drivers]);

  if (!prediction) {
    return <div className="drift-empty">{playerName} не поставил(а) прогноз на эту гонку.</div>;
  }

  const withActual = slots.filter((s) => s.actualPos !== null);
  const avgMiss = withActual.length
    ? (
        withActual.reduce((sum, s) => sum + Math.abs((s.actualPos as number) - s.predictedPos), 0) /
        withActual.length
      ).toFixed(1)
    : '—';

  return (
    <div className="drift">
      <h3 className="drift-title">
        Прогноз {playerName} vs факт · {raceName} — {points} очков
      </h3>
      <div className="drift-canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
      <div className="drift-summary">
        <div className="drift-card"><span className="drift-card-v">{points}</span><span className="drift-card-l">очков</span></div>
        <div className="drift-card"><span className="drift-card-v">{exactHits}</span><span className="drift-card-l">точных</span></div>
        <div className="drift-card"><span className="drift-card-v">{avgMiss}</span><span className="drift-card-l">средний промах</span></div>
        <div className="drift-card"><span className="drift-card-v">{withActual.length}/10</span><span className="drift-card-l">в топ-10</span></div>
      </div>
      <div className="drift-legend">
        <span><i className="drift-dot" style={{ background: '#4ade80' }} /> точно</span>
        <span><i className="drift-dot" style={{ background: '#00E5FF' }} /> ±1</span>
        <span><i className="drift-dot" style={{ background: '#E8C15A' }} /> близко</span>
        <span><i className="drift-dot" style={{ background: '#5a6273' }} /> мимо / 0 очков</span>
      </div>
      <button
        type="button"
        className="link-btn drift-explain-toggle"
        aria-expanded={explainOpen}
        onClick={() => setExplainOpen((v) => !v)}
      >
        Почему такие очки? {explainOpen ? '▴' : '▾'}
      </button>
      {explainOpen && (
        <p className="drift-explain-text">
          Очки зависят от места, на которое ты поставил пилота, а не от того, где он финишировал на
          самом деле. Например: поставил на P9 (макс. 2 очка) и промахнулся на 2 позиции — штраф
          съедает всё, будет 0. А промах на P1 (25 очков) прощается щедрее.
        </p>
      )}
    </div>
  );
}
