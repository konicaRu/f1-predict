// Разовая демонстрация согласована на 19.11.2026, 09:00 МСК. Не вызывает notify.main().
const { q, close, sendTelegramDossier } = require('./lib');
const { predictButton } = require('./notify');
const { loadDossier } = require('./dossier');
const { buildDossierMessage } = require('./dossier-message');

const keys = { card: '488d8052-b520-4569-b862-192026110901', legacy: '488d8052-b520-4569-b862-192026110902' };
function isShowcaseWindow(now) {
  const t = now.getTime();
  return t >= Date.parse('2026-11-19T06:00:00Z') && t < Date.parse('2026-11-19T07:00:00Z');
}
async function getShowcaseRace() {
  const { rows } = await q(`select id, season, round, name, deadline_utc, race_datetime_utc
    from races where season = 2026 and round = 21 and status = 'open' and deadline_utc > now()`);
  return rows[0] || null;
}
async function claimFormat(format) {
  const { rows } = await q(`insert into job_runs (job, ok, errors, run_key)
    values ($1, false, $2, $3) on conflict (run_key) do nothing returning run_key`,
  [`showcase:2026-11-19:${format}`, ['Отправка зарезервирована; при неопределённом исходе автоматически не повторять'], keys[format]]);
  return rows.length === 1;
}
async function finishFormat(format, ok, error) {
  await q('update job_runs set ok = $1, errors = $2 where run_key = $3', [ok, error ? [error] : [], keys[format]]);
}
async function runShowcase({ clock = () => new Date(), now = clock(), checkOnly = false, getRace = getShowcaseRace,
  getDossier = loadDossier, claim = claimFormat, finish = finishFormat, send = sendTelegramDossier } = {}) {
  if (!checkOnly && !isShowcaseWindow(now)) {
    if (now >= new Date('2026-11-19T07:00:00Z') && now < new Date('2026-11-19T21:00:00Z')) throw new Error('Пропущено окно демонстрации 19.11.2026 09:00–10:00 МСК');
    return { skipped: true, reason: 'Вне разового окна 19.11.2026 09:00–10:00 МСК' };
  }
  const ensureWindow = () => { if (!isShowcaseWindow(clock())) throw new Error('Закрылось окно демонстрации 19.11.2026 09:00–10:00 МСК'); };
  const race = await getRace();
  if (!race) throw new Error('Не найдена открытая гонка Лас-Вегаса-2026 с будущим дедлайном');
  const dossier = await getDossier(race, { now, includeHistory: true });
  if (!dossier.circuit || !dossier.previousRaceHistory) throw new Error('Не удалось подтвердить трассу и историю: демонстрацию не отправляем');
  const messages = ['card', 'legacy'].map(format => buildDossierMessage(race, dossier, { mode: 'deadline', format }));
  if (checkOnly) return { checked: true, raceId: race.id, formats: messages.map(m => m.format), warnings: dossier.warnings || [] };
  const sent = [], errors = [];
  for (const message of messages) {
    ensureWindow();
    if (!await claim(message.format)) continue;
    let error;
    try {
      await send(message, predictButton(race.id), warning => console.warn(warning), { beforeSend: ensureWindow });
      sent.push(message.format);
    } catch (e) { error = e.message; errors.push(`${message.format}: ${error}`); }
    // Резервирование остаётся даже при таймауте: Telegram мог уже принять сообщение.
    try { await finish(message.format, !error, error); }
    catch (e) { errors.push(`${message.format}: запись результата: ${e.message}`); }
  }
  if (errors.length) throw new Error(errors.join('; '));
  return { sent };
}
if (require.main === module) {
  runShowcase({ checkOnly: process.argv.includes('--check') }).then(result => console.log(JSON.stringify(result)))
    .catch(e => { console.error(e.message); process.exitCode = 1; }).finally(close);
}
module.exports = { runShowcase, isShowcaseWindow };
