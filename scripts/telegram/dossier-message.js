const fs = require('fs');
const path = require('path');
const { buildDossierCard, windLabel } = require('./dossier-card');
const { renderDossierCard } = require('./render-dossier-card');
const { buildBannerSvg } = require('./dossier-banner');
const { previousHistory, strategyLines, count } = require('./race-history');

const escape = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dateTime = iso => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const n = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);

function weatherLines(d) {
  const w = d.weather;
  const lines = [];
  if (!w) lines.push('Почасовой прогноз пока недоступен.');
  else {
    lines.push('Прогноз на первые 2 часа гонки:');
    lines.push(`Воздух: ${w.air ? w.air[0] === w.air[1] ? `${n(w.air[0])} °C` : `${n(w.air[0])}…${n(w.air[1])} °C` : 'нет данных'}.`);
    lines.push(`Дождь: ${w.rainMax == null ? 'нет данных' : `до ${n(w.rainMax)}% по часам`}.`);
    lines.push(`Ветер: ${w.windMax == null ? 'нет данных' : `до ${n(w.windMax)} м/с`}.`);
    lines.push(windLabel(w.windDirection));
    lines.push(`Open-Meteo · получено ${dateTime(w.fetchedAt)} МСК.`);
  }
  const track = d.trackTemperature;
  lines.push(track ? `Полотно: ${n(track.value)} °C · ${track.session}, ${dateTime(track.at)} МСК — замер, не прогноз полотна.` : 'Полотно: свежих замеров пока нет.');
  return lines;
}

function buildDossierMessage(race, d, { mode = 'raceweek', missing, format = 'card' } = {}) {
  const opening = mode === 'raceweek';
  const sections = [];
  const add = (title, lines) => sections.push({ title, lines });
  add(opening ? 'Приём прогнозов открыт' : 'Не забудь сделать прогноз', [
    `${race.name} · раунд ${race.round}`,
    `Дедлайн: ${dateTime(race.deadline_utc)} МСК.`,
    `Старт гонки: ${dateTime(race.race_datetime_utc)} МСК.`,
  ]);
  {
    if (d.circuit) {
      const f = d.facts;
      const characteristics = [d.circuit.name];
      if (f) {
        characteristics.push(`${String(f.lengthKm).replace('.', ',')} км · ${f.corners} поворотов · ${f.laps} кругов.`);
        characteristics.push(f.elevationChangeM != null ? `Перепад высот: ${f.elevationChangeM} м.` : 'Перепад высот: нет данных.');
        if (f.record) characteristics.push(`Рекорд круга в гонке: ${f.record.time} · ${f.record.driver}, ${f.record.year} (F1, данные по ${f.verifiedThrough} год).`);
      }
      add('Досье трассы', characteristics);
    } else add('Досье трассы', ['Досье временно недоступно; прогнозы принимаются как обычно.']);
    const p = d.previous;
    if (p) {
      add(`Ориентиры ${p.year} года`, [
        p.fastest ? `Лучший круг гонки: ${p.fastest.time} · ${p.fastest.driver}.` : 'Лучший круг гонки: нет данных.',
        p.pole ? `Поул: ${p.pole.time} · ${p.pole.driver}.` : 'Поул: нет данных.',
        'Сессии могли проходить в разных условиях; времена не сравнивают напрямую.',
      ]);
    }
    const history = previousHistory(race, d);
    add(`Нейтрализации · ${Number(race.season) - 1}`, history ? [
      `Сейфти-кар (SC): ${count(history.safetyCars)}.`,
      `Виртуальный сейфти-кар (VSC): ${count(history.virtualSafetyCars)}.`,
      `Красные флаги: ${count(history.redFlags)}.`,
      'Число отдельных эпизодов · журнал дирекции FIA.',
    ] : ['Нет подтверждённых данных.']);
    add(`Шины и пит-стопы · ${Number(race.season) - 1}`, strategyLines(history));
    add('Последние победители', d.winners === null || !d.winners ? ['История временно недоступна.'] : d.winners.length ? d.winners.slice(0, 3).map(w => `${w.year} · ${w.driver}`) : ['На этой трассе пока нет завершённых гонок в источнике.']);
  }
  add('Погода на трассе', weatherLines(d));
  if (!opening && Array.isArray(missing)) add('Ещё не сделали прогноз', [missing.length ? missing.join(', ').slice(0, 650) : 'Все уже сделали прогноз!']);
  const buttonUrl = `https://t.me/che_f1_predict_bot/predict?startapp=predict_${encodeURIComponent(race.id)}`;
  const asset = path.join(__dirname, 'assets', d.facts?.geometry ? `${d.circuit.id}.png` : 'dossier.png');
  const banner = fs.existsSync(asset) ? fs.readFileSync(asset) : null;
  let coordinates;
  if (d.facts?.geometry && path.basename(d.facts.geometry) === d.facts.geometry) {
    const geometry = path.join(__dirname, 'data', d.facts.geometry);
    if (fs.existsSync(geometry)) coordinates = JSON.parse(fs.readFileSync(geometry, 'utf8')).features[0].geometry.coordinates;
  }
  const bannerHtml = format === 'legacy' ? `<!doctype html><html><meta charset="utf-8"><style>html,body{margin:0;width:1080px}svg{display:block;width:100%;height:auto}</style><body>${buildBannerSvg(d.facts?.title || d.circuit?.name || race.name, coordinates, { start: race.race_datetime_utc })}</body></html>` : undefined;
  const image = banner || bannerHtml ? '<img src="tg://photo?id=dossier_banner"/>' : '';
  const richHtml = image + sections.map(s => `<h3>${escape(s.title)}</h3><p>${s.lines.map(escape).join('<br>')}</p>`).join('') +
    `<p><a href="${buttonUrl}">Сделать прогноз</a></p>` +
    (d.sources?.length ? `<details><summary>Источники</summary>${d.sources.map(s => `<p><a href="${escape(s.url)}">${escape(s.name)}</a></p>`).join('')}</details>` : '');
  const fallbackHtml = '<b>ЛИГА ПРОРОКОВ</b>\n\n' + sections.map(s => `<b>${escape(s.title)}</b>\n${s.lines.map(escape).join('\n')}`).join('\n\n') +
    (d.sources?.length ? `\n\n<b>Источники</b>\n${d.sources.map(s => `<a href="${escape(s.url)}">${escape(s.name)}</a>`).join(' · ')}` : '') +
    `\n\n<a href="${buttonUrl}">Сделать прогноз</a>`;
  if (fallbackHtml.length > 4096) throw new Error('Досье превышает лимит обычного сообщения');
  const photoCaption = `${opening ? '🏁 Приём прогнозов открыт' : '⏳ Не забудь сделать прогноз'}\n${sections[0].lines.join('\n')}` +
    (!opening && Array.isArray(missing) ? `\n\n${missing.length ? `Ещё не сделали прогноз: ${missing.join(', ').slice(0, 650)}` : 'Все уже сделали прогноз!'}` : '');
  return { format, richHtml, fallbackHtml, banner, bannerHtml, cardHtml: format === 'card' ? buildDossierCard(race, d) : undefined, photoCaption: photoCaption.slice(0, 1024) };
}

async function deliverDossier(message, { token, chatId, replyMarkup, fetchImpl = fetch, renderCard = renderDossierCard, renderBanner = renderDossierCard, beforeSend = () => {}, onFallback = () => {} }) {
  const sendText = async () => {
    await beforeSend();
    const fallback = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ chat_id: chatId, text: message.fallbackHtml, parse_mode: 'HTML', reply_markup: replyMarkup, link_preview_options: { is_disabled: true } }),
    });
    const result = await fallback.json();
    if (!result.ok) throw new Error(`Telegram fallback: ${result.error_code || fallback.status}`);
    return result;
  };
  if (message.format === 'legacy') {
    let banner = message.banner;
    if (message.bannerHtml) {
      try { banner = await renderBanner(message.bannerHtml); }
      catch (error) { onFallback(`Шапка не отрисована: ${error.message}; время старта сохранено в тексте`); }
    }
    const rich = { html: message.richHtml };
    if (!banner) rich.html = rich.html.replace('<img src="tg://photo?id=dossier_banner"/>', '');
    if (banner) rich.media = [{ id: 'dossier_banner', media: { type: 'photo', media: 'attach://banner' } }];
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('rich_message', JSON.stringify(rich));
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    if (banner) form.append('banner', new Blob([banner], { type: 'image/png' }), 'dossier.png');
    await beforeSend();
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendRichMessage`, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (data.ok) return data;
    if (![400, 404].includes(data.error_code)) throw new Error(`Telegram Rich Message: ${data.error_code || response.status}`);
    onFallback(`Rich Message отклонён Telegram (${data.error_code}); отправляем текст`);
    return sendText();
  }
  let photo;
  try {
    photo = await renderCard(message.cardHtml);
  } catch (error) {
    onFallback(`Карточка не отрисована: ${error.message}; отправляем текст`);
  }
  if (photo) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', message.photoCaption);
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    form.append('photo', new Blob([photo], { type: 'image/png' }), 'dossier.png');
    // Не повторяем запрос при таймауте/5xx: сообщение могло быть доставлено.
    await beforeSend();
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (data.ok) return data;
    if (![400, 404].includes(data.error_code)) throw new Error(`Telegram photo: ${data.error_code || response.status}`);
    onFallback(`Фото отклонено Telegram (${data.error_code}); отправляем текст`);
  }
  return sendText();
}

module.exports = { buildDossierMessage, deliverDossier, weatherLines };
