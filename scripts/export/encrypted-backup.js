const crypto = require('crypto');
const FORMAT = 'F1_FULL_BACKUP_V1';

function keyBytes(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key.trim())) throw new Error('Backup key must be 64 hex characters');
  return Buffer.from(key.trim(), 'hex');
}

function encryptBackup(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(Buffer.from(FORMAT));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { version: FORMAT, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function decryptBackup(envelope, key) {
  if (envelope?.version !== FORMAT) throw new Error('Unsupported backup format');
  const bytes = keyBytes(key);
  try {
    const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', bytes, iv);
    decipher.setAAD(Buffer.from(FORMAT));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  } catch { throw new Error('Unable to decrypt or verify backup'); }
}

module.exports = { encryptBackup, decryptBackup };
