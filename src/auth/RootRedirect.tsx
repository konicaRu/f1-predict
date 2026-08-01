import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

// Корень сайта: есть сессия -> обычный кабинет участника, нет сессии -> гостевой просмотр.
export function RootRedirect() {
  const { session, loading } = useAuth();
  if (loading) return <div style={{ padding: 24, color: '#fff' }}>Загрузка…</div>;
  return <Navigate to={session ? '/calendar' : '/g/calendar'} replace />;
}
