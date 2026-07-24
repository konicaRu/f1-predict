import { WEIGHTS } from '../lib/scoring';

interface RuleExample {
  emoji: string;
  title: string;
  desc: string;
  result: string;
}

const EXAMPLES: RuleExample[] = [
  { emoji: '🎯', title: 'Точно.', desc: 'Норрис на P1, приехал P1', result: '25 + 3 = 28' },
  { emoji: '👍', title: 'Почти точно (ошибка 1 место).', desc: 'Леклер на P2, приехал P3', result: '18 − 2 = 16' },
  { emoji: '📉', title: 'Недооценил.', desc: 'Расселл на P5, приехал P2', result: '10 − 6 = 4' },
  { emoji: '📈', title: 'Переоценил, но не зря.', desc: 'Ферстаппен на P1, приехал P4', result: '25 − 6 = 19' },
  { emoji: '💥', title: 'Большой промах.', desc: 'Гасли на P3, приехал P9', result: '15 − 12 = 3' },
  { emoji: '❌', title: 'Мимо топ-10.', desc: 'Боттас на P8, финишировал 14-м', result: '0' },
  { emoji: '🕳️', title: 'Обрезано до нуля.', desc: 'Алонсо на P10, приехал P3', result: '1 − 14 = −13 → 0' },
];

const STRATEGY: string[] = [
  'Рисковать наверху выгодно: даже промах на P1 (25 базовых очков) при ошибке в 3 места всё равно даёт 19 очков.',
  'Внизу жёстче: P10 стоит всего 1 очко, точное попадание — 4 (1+3), а промах даже на 1 место — уже 0.',
  'Главный скилл — угадать не только КТО попадёт в топ-10, но и НА КАКОМ МЕСТЕ. Состав без правильного порядка почти ничего не стоит.',
  'Реалистично хороший результат за гонку — 70–90 очков из максимума 131.',
];

export default function Rules() {
  return (
    <div className="rules">
      <h1 className="page-h1">🏁 Как считаются очки</h1>

      <div className="rules-table-wrap">
        <table className="rules-table">
          <thead>
            <tr>
              {WEIGHTS.map((_, i) => (
                <th key={i}>P{i + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {WEIGHTS.map((w, i) => (
                <td key={i}>{w}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <pre className="rules-formula">{`очки = вес(твоей позиции) − 2 × |реальная позиция − твоя позиция|
если попал ТОЧНО — плюс 3 очка
очки не бывают отрицательными — минимум 0`}</pre>

      <p className="rules-why">
        Очки считаются по позиции, на которую ты поставил пилота (Y), а не по той, что он занял на
        самом деле (X). Так награждается смелость и точность твоей ставки: поставил на P1 и угадал —
        получаешь ценность P1. Если бы считали по факту, было бы выгоднее угадывать очевидного
        фаворита на первом месте, а сложные ставки в середине и хвосте почти ничего бы не стоили.
      </p>

      <div className="rules-examples">
        {EXAMPLES.map((ex, i) => (
          <div className="rules-example" key={i}>
            <span className="rules-example-emoji">{ex.emoji}</span>
            <div>
              <strong>{ex.title}</strong> {ex.desc} → <code>{ex.result}</code>
            </div>
          </div>
        ))}
      </div>

      <h2 className="col-h">🧠 Стратегия</h2>
      <ul className="rules-strategy">
        {STRATEGY.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>

      <p className="rules-tiebreak">
        🏆 <strong>Тайбрейкер сезона:</strong> при равной сумме очков за сезон решает — сначала у кого
        больше точных попаданий (когда предсказанное место совпало с реальным), если и это равно — у
        кого лучший результат в одной отдельной гонке.
      </p>
    </div>
  );
}
