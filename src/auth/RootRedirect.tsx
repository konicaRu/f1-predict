import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getTelegramDeepLinkRaceId } from '../lib/telegram';

// Корень сайта: есть сессия -> обычный кабинет участника (или конкретная гонка из диплинка
// напоминания), нет сессии -> гостевой просмотр.
export function RootRedirect() {
  const { session, loading } = useAuth();
  if (loading) return <div style={{ padding: 24, color: '#fff' }}>Загрузка…</div>;
  if (!session) return <Navigate to="/g/calendar" replace />;
  const raceId = getTelegramDeepLinkRaceId();
  return <Navigate to={raceId ? `/predict/${raceId}` : '/calendar'} replace />;
}
