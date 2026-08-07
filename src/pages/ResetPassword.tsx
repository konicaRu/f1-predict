import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import PasswordInput from '../components/PasswordInput';

export default function ResetPassword() {
  const [status, setStatus] = useState<'checking' | 'ready' | 'invalid'>('checking');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setStatus(data.session ? 'ready' : 'invalid');
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (password !== password2) {
      setErr('Пароли не совпадают');
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    nav('/calendar');
  }

  if (status === 'checking') return <div className="stub">Загрузка…</div>;

  if (status === 'invalid')
    return (
      <div className="auth-card">
        <h1>Ссылка недействительна</h1>
        <p>Ссылка для сброса пароля недействительна или уже была использована.</p>
        <p><Link to="/login">Ко входу</Link></p>
      </div>
    );

  return (
    <form onSubmit={submit} className="auth-card">
      <h1>Новый пароль</h1>
      <PasswordInput value={password} onChange={setPassword} placeholder="новый пароль" required />
      <PasswordInput value={password2} onChange={setPassword2} placeholder="повторите пароль" required />
      {err && <p className="auth-err">{err}</p>}
      <button disabled={busy} type="submit">{busy ? '…' : 'Сохранить пароль'}</button>
    </form>
  );
}
