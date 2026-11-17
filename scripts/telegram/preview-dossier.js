// Только публичные API и локальные файлы: не импортирует lib.js, не читает .env/БД, не отправляет сообщения.
const fs = require('fs');
const path = require('path');
const { loadDossier } = require('./dossier');
const { buildDossierMessage } = require('./dossier-message');
const { deadlineUtc } = require('../import/deadlines');

async function main() {
  const season = Number(process.argv[2] || new Date().getUTCFullYear());
  const round = Number(process.argv[3] || 21);
  if (!Number.isInteger(season) || season < 1950 || !Number.isInteger(round) || round < 1) throw new Error('Usage: node preview-dossier.js YEAR ROUND');
  const response = await fetch(`https://api.jolpi.ca/ergast/f1/${season}/${round}.json`, { headers: { 'User-Agent': 'F1Predict/1.0' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Календарь: HTTP ${response.status}`);
  const event = (await response.json()).MRData?.RaceTable?.Races?.[0];
  if (!event?.time) throw new Error('Нет времени старта в календаре');
  const race = { id: 'preview', season, round, name: event.raceName, deadline_utc: deadlineUtc(event.date), race_datetime_utc: `${event.date}T${event.time}` };
  const dossier = await loadDossier(race);
  const opening = buildDossierMessage(race, dossier);
  const reminder = buildDossierMessage(race, dossier, { mode: 'deadline', missing: ['Iceman', 'MARTIN'] });
  function preview(message) {
    let html = message.richHtml;
    if (message.banner) html = html.replace('tg://photo?id=dossier_banner', `data:image/png;base64,${message.banner.toString('base64')}`);
    // Это предпросмотр: кнопка не открывает несуществующую гонку preview.
    return html.replace(/href="https:\/\/t\.me\/che_f1_predict_bot\/predict\?startapp=predict_preview"/g, 'href="#" onclick="event.preventDefault()"');
  }
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Лига пророков — автоматическое досье</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f3f0;color:#24242d;font:14px/1.5 Arial,sans-serif}header{background:#16161e;border-bottom:4px solid #e10600;color:white;padding:24px 40px;font:700 24px Bahnschrift,Arial}main{max-width:1120px;margin:auto;padding:25px 25px 40px}h1{font:700 28px Bahnschrift,Arial;margin:4px 0 7px}.note{font-size:12px;color:#72727c;margin-bottom:23px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:25px;align-items:start}.label{font:700 11px Bahnschrift,Arial;letter-spacing:1.5px;margin-bottom:10px;color:#72727d}.stage{background:#dfe5dc;border-radius:15px;padding:13px}.message{background:white;border-radius:11px;overflow:hidden;padding-bottom:15px}.sender{color:#c52820;font-size:12px;padding:9px 20px}img{display:block;width:100%}h3{font:700 19px Bahnschrift,Arial;margin:20px 20px 7px}p{margin:0 20px 14px}p a{display:block;background:#d8e3d3;color:#334b2d;text-align:center;padding:11px;border-radius:6px;font-weight:bold;text-decoration:none}details{font-size:11px;margin:10px 20px;color:#73737d}details p{margin:8px 0}details a{background:transparent;padding:0;text-align:left;font-weight:normal}footer{font-size:11px;color:#85858f;margin-top:22px}@media(max-width:760px){.grid{grid-template-columns:1fr}main{padding:15px}header{padding:20px}}</style><header>F1 PREDICT <span style="color:#ed1609">/</span> ЛИГА ПРОРОКОВ</header><main><h1>Досье собирается автоматически</h1><div class="note">Публичные данные · получено ${dossier.fetchedAt} · не отправлено в Telegram. Список не проголосовавших в напоминании — пример.</div><div class="grid"><section><div class="label">01 / ОТКРЫТИЕ ПРОГНОЗОВ</div><div class="stage"><article class="message"><div class="sender">f1_predict_bot</div>${preview(opening)}</article></div></section><section><div class="label">02 / НАПОМИНАНИЕ ПЕРЕД ДЕДЛАЙНОМ</div><div class="stage"><article class="message"><div class="sender">f1_predict_bot</div>${preview(reminder)}</article></div></section></div><footer>Предпросмотр Rich HTML. Текст в Telegram зависит от темы клиента. Кнопки отключены в этом примере.</footer></main></html>`;
  const target = path.join(__dirname, '../../docs/mockups/telegram-dossier-live');
  fs.writeFileSync(`${target}.html`, html);
  fs.writeFileSync(`${target}.json`, JSON.stringify({ race, dossier, fallbackHtml: opening.fallbackHtml }, null, 2));
  console.log(`Preview: ${target}.html`);
  console.log(JSON.stringify({ circuit: dossier.circuit?.id, winners: dossier.winners?.length, previous: dossier.previous, weather: dossier.weather, track: dossier.trackTemperature, warnings: dossier.warnings }, null, 2));
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
