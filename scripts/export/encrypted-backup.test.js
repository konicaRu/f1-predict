const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { encryptBackup, decryptBackup } = require('./encrypted-backup');

test('encrypted backup retains binary dump and contains no plaintext password hash', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const raw = Buffer.concat([Buffer.from('Пользователь password_hash_secret 9007199254740993'), Buffer.from([0, 255, 1])]);
  const sealed = encryptBackup(raw, key);
  assert.deepEqual(decryptBackup(sealed, key), raw);
  assert.equal(JSON.stringify(sealed).includes('password_hash_secret'), false);
  assert.notEqual(encryptBackup(raw, key).iv, sealed.iv);
});

test('wrong key, corrupted ciphertext and altered authentication tag fail closed', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const sealed = encryptBackup(Buffer.from('private data'), key);
  assert.throws(() => decryptBackup(sealed, crypto.randomBytes(32).toString('hex')), /decrypt|verify/i);
  const bytes = Buffer.from(sealed.ciphertext, 'base64'); bytes[0] ^= 1;
  assert.throws(() => decryptBackup({ ...sealed, ciphertext: bytes.toString('base64') }, key), /decrypt|verify/i);
  assert.throws(() => decryptBackup({ ...sealed, tag: Buffer.alloc(16).toString('base64') }, key), /decrypt|verify/i);
});

test('invalid key and unsupported format are rejected', () => {
  assert.throws(() => encryptBackup(Buffer.from('data'), 'short'), /key/i);
  assert.throws(() => decryptBackup({ version: 'unknown' }, 'a'.repeat(64)), /format/i);
});
