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

  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMsg, setForgotMsg] = useState('');
  const [forgotBusy, setForgotBusy] = useState(false);

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

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault();
    setForgotBusy(true);
    await supabase.auth.resetPasswordForEmail(forgotEmail, {
      redirectTo: `${window.location.origin}/f1-predict/reset`,
    });
    setForgotBusy(false);
    setForgotMsg('Если такой email зарегистрирован, письмо со ссылкой на сброс отправлено.');
  }

  if (forgotOpen) {
    return (
      <form onSubmit={submitForgot} className="auth-card">
        <h1>Забыли пароль?</h1>
        <input
          type="email"
          placeholder="email"
          value={forgotEmail}
          onChange={(e) => setForgotEmail(e.target.value)}
          required
        />
        {forgotMsg && <p>{forgotMsg}</p>}
        <button disabled={forgotBusy} type="submit">{forgotBusy ? '…' : 'Отправить ссылку'}</button>
        <p>
          <button type="button" className="link-btn" onClick={() => { setForgotOpen(false); setForgotMsg(''); }}>
            Назад ко входу
          </button>
        </p>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="auth-card">
      <h1>Вход</h1>
      <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input type="password" placeholder="пароль" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {err && <p className="auth-err">{err}</p>}
      <button disabled={busy} type="submit">{busy ? '…' : 'Войти'}</button>
      <p>
        <button type="button" className="link-btn" onClick={() => { setForgotOpen(true); setForgotEmail(email); }}>
          Забыли пароль?
        </button>
      </p>
      <p>Нет аккаунта? <Link to="/signup">Регистрация</Link></p>
    </form>
  );
}
