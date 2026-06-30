import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const { refreshMembership } = useAuth();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    await refreshMembership();
    nav('/');
  }

  return (
    <form onSubmit={submit} className="auth-card">
      <h1>Вход</h1>
      <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input type="password" placeholder="пароль" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {err && <p className="auth-err">{err}</p>}
      <button disabled={busy} type="submit">{busy ? '…' : 'Войти'}</button>
      <p>Нет аккаунта? <Link to="/signup">Регистрация</Link></p>
    </form>
  );
}
