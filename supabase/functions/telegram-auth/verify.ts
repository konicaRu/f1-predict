// supabase/functions/telegram-auth/verify.ts
export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export type VerifyResult =
  | { ok: true; user: TelegramUser }
  | { ok: false; reason: string };

export async function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 86400,
): Promise<VerifyResult> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no hash field' };
  params.delete('hash');

  const pairs = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
  const dataCheckString = pairs.join('\n');

  const encoder = new TextEncoder();
  const secretKeyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secretKeyBytes = await crypto.subtle.sign('HMAC', secretKeyMaterial, encoder.encode(botToken));

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secretKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(dataCheckString));
  const computedHash = [...new Uint8Array(signatureBytes)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (computedHash !== hash) return { ok: false, reason: 'signature mismatch' };

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) {
    return { ok: false, reason: 'stale auth_date' };
  }

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, reason: 'no user field' };
  let user: TelegramUser;
  try {
    user = JSON.parse(userRaw) as TelegramUser;
  } catch {
    return { ok: false, reason: 'user field not valid JSON' };
  }
  if (typeof user.id !== 'number') return { ok: false, reason: 'user.id missing' };

  return { ok: true, user };
}
