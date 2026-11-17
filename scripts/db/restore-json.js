// Node 22+: сохраняем исходные числовые токены при повторной сериализации в staging.
function parseRestoreRows(json) {
  if (typeof JSON.rawJSON !== 'function') throw new Error('Restore requires Node.js 22+ with JSON.rawJSON');
  const rows = JSON.parse(json, (_key, value, context) =>
    typeof value === 'number' ? JSON.rawJSON(context.source) : value);
  if (!Array.isArray(rows)) throw new Error('Backup must contain a JSON array');
  return rows;
}
module.exports = { parseRestoreRows };
