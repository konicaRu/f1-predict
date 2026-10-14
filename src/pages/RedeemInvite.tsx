import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { redeemInvite } from '../lib/db';
import { useAuth } from '../auth/AuthContext';
import { trackEvent } from '../lib/analytics';

export default function RedeemInvite() {
  const tgUser = (window as any).Telegram?.WebApp?.initDataUnsafe?.user;
  const [name, setName] = useState(tgUser?.first_name ?? tgUser?.username ?? '');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const { refreshMembership, signOut, isMember } = useAuth();

  // Проверка членства может закончиться уже ПОСЛЕ того, как экран показался (вход по паролю, медленная
  // сеть) — участнику тут делать нечего, сразу в кабинет.
  useEffect(() => {
    if (isMember) nav('/', { replace: true });
  }, [isMember, nav]);

  // Сюда попадают и те, кто уже в лиге, но Telegram впустил их под пустым аккаунтом (см. AuthContext):
  // выходим из него и ведём на обычный вход по email и паролю.
  async function toLogin() {
    trackEvent('redeem_to_login');
    await signOut();
    nav('/login');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await redeemInvite(code, name);
    } catch (e: any) {
      setBusy(false);
      setErr(e.message || 'Не удалось выполнить, попробуй ещё раз');
      return;
    }
    setBusy(false);
    trackEvent('sign_up', { method: 'telegram_invite' });
    await refreshMembership();
    nav('/');
  }

  return (
    <form onSubmit={submit} className="auth-card">
      <h1>Вступление в лигу</h1>
      <p>Аккаунт есть, но ты ещё не в лиге — введи инвайт-код.</p>
      <input placeholder="имя в лиге" value={name} onChange={(e) => setName(e.target.value)} required />
      <input placeholder="инвайт-код" value={code} onChange={(e) => setCode(e.target.value)} required />
      {err && <p className="auth-err">{err}</p>}
      <button disabled={busy} type="submit">{busy ? '…' : 'Вступить'}</button>
      <p>Уже есть аккаунт в лиге?</p>
      <button type="button" onClick={toLogin}>Войти по паролю</button>
    </form>
  );
}
