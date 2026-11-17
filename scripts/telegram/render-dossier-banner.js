// Офлайн-генерация исходного SVG. PNG создаётся один раз браузером, в CI рендерер не нужен.
const fs = require('fs');
const path = require('path');
const { buildBannerSvg } = require('./dossier-banner');
const assets = path.join(__dirname, 'assets');
fs.mkdirSync(assets, { recursive: true });
const geometry = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'vegas.geojson'), 'utf8'));
fs.writeFileSync(path.join(assets, 'vegas.svg'), buildBannerSvg('LAS VEGAS', geometry.features[0].geometry.coordinates));
fs.writeFileSync(path.join(assets, 'dossier.svg'), buildBannerSvg('ДОСЬЕ ТРАССЫ'));
