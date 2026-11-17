const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRestoreRows } = require('./restore-json');

test('restore preserves bigint IDs and numeric literals when staging JSON', () => {
  const json = '[{"id":9007199254740993,"name":"Игрок","positions":["a","b"],"value":0.1234567890123456789}]';
  const rows = parseRestoreRows(json);
  assert.equal(JSON.stringify(rows), json);
});
