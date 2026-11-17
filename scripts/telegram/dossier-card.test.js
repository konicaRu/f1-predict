const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeWeather } = require('./dossier');

test('wind direction uses the first race hour, including north at zero degrees', () => {
  const hourly = { time: ['2026-11-22T04:00', '2026-11-22T05:00'], wind_speed_10m: [2, 3], wind_direction_10m: [0, 180] };
  assert.equal(summarizeWeather({ hourly }, '2026-11-22T04:00:00Z').windDirection, 0);
  hourly.wind_direction_10m[0] = 360;
  assert.equal(summarizeWeather({ hourly }, '2026-11-22T04:00:00Z').windDirection, 0);
});

test('missing, invalid and calm wind direction stays unavailable', () => {
  for (const direction of [undefined, null, -1, 361, '90']) {
    const hourly = { time: ['2026-11-22T04:00', '2026-11-22T05:00'], wind_speed_10m: [2, 3], wind_direction_10m: [direction, 180] };
    assert.equal(summarizeWeather({ hourly }, '2026-11-22T04:00:00Z').windDirection, null);
  }
  const hourly = { time: ['2026-11-22T04:00', '2026-11-22T05:00'], wind_speed_10m: [0, 3], wind_direction_10m: [90, 180] };
  assert.equal(summarizeWeather({ hourly }, '2026-11-22T04:00:00Z').windDirection, null);
});
