function buildBannerSvg(title, coordinates) {
  let circuit = '';
  if (coordinates?.length) {
    const xs = coordinates.map(p => p[0]), ys = coordinates.map(p => p[1]);
    const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    const h = ymax - ymin, w = (xmax - xmin) * Math.cos(36.12 * Math.PI / 180);
    const points = coordinates.map(p => {
      const x = ((p[0] - xmin) / (xmax - xmin) - .5) * w / h * 390;
      const y = (.5 - (p[1] - ymin) / h) * 390;
      return [870 + x * 1.1 + y * .55, 300 + y * .72];
    });
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${p.map(x => x.toFixed(2)).join(',')}`).join(' ') + 'Z';
    circuit = `<path d="${d}" fill="none" stroke="#050508" stroke-width="24" transform="translate(0,10)" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#454550" stroke-width="18" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#ff3328" stroke-width="5" stroke-linejoin="round"/><circle cx="${points[0][0]}" cy="${points[0][1]}" r="7" fill="white"/><text x="665" y="510" font-size="17" fill="#a8a8b6">ВИД В ПЕРСПЕКТИВЕ · БЕЗ МОДЕЛИ РЕЛЬЕФА</text>`;
  }
  const safeTitle = title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600"><defs><linearGradient id="bg" x2="0" y2="1"><stop stop-color="#1b1b25"/><stop offset="1" stop-color="#101017"/></linearGradient><pattern id="stripes" width="300" height="600" patternUnits="userSpaceOnUse" patternTransform="skewX(-45)"><rect width="74" height="600" fill="#676775" opacity=".25"/><rect x="88" width="65" height="600" fill="#454552" opacity=".27"/></pattern></defs><rect width="1200" height="600" fill="url(#bg)"/><rect width="1200" height="600" fill="url(#stripes)"/><g font-family="Bahnschrift,Arial,sans-serif"><text x="48" y="65" font-size="29" font-weight="700" fill="#fff"><tspan fill="#f51b0d">///</tspan> F1 PREDICT</text><text x="900" y="65" font-size="22" letter-spacing="2" fill="#dedee6">ЛИГА ПРОРОКОВ</text><text x="50" y="184" font-size="19" letter-spacing="3" fill="#ff655b">ПЕРЕД ТВОИМ ПРОГНОЗОМ</text><text x="46" y="260" font-size="${coordinates ? 67 : 76}" font-weight="800" fill="white">${safeTitle}</text><path d="M50 292H170" stroke="#e10600" stroke-width="5"/><text x="50" y="345" font-size="23" fill="#c3c3cf">История. Условия. Твоя десятка.</text>${circuit}<text x="50" y="550" font-size="17" letter-spacing="2" fill="#a1a1b1">F1 PREDICT / ЛИГА ПРОРОКОВ</text></g><rect y="594" width="1200" height="6" fill="#e10600"/></svg>`;
}
module.exports = { buildBannerSvg };
