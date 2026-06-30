import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';

export default function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const { refreshMembership } = useAuth();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    const { error: e1 } = await supabase.auth.signUp({ email, password });
    if (e1) {
      setBusy(false);
      setErr(e1.message);
      return;
    }
    const { error: e2 } = await supabase.rpc('redeem_invite', { p_code: code, p_display_name: name });
    setBusy(false);
    if (e2) {
      setErr('Код неверный или регистрация не завершена: ' + e2.message);
      return;
    }
    await refreshMembership();
    nav('/');
  }

  return (
    <form onSubmit={submit} className="auth-card">
      <h1>Регистрация</h1>
      <input placeholder="имя в лиге" value={name} onChange={(e) => setName(e.target.value)} required />
      <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input type="password" placeholder="пароль (мин. 6)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
      <input placeholder="инвайт-код лиги" value={code} onChange={(e) => setCode(e.target.value)} required />
      {err && <p className="auth-err">{err}</p>}
      <button disabled={busy} type="submit">{busy ? '…' : 'Создать аккаунт'}</button>
      <p>Уже есть аккаунт? <Link to="/login">Вход</Link></p>
    </form>
  );
}
