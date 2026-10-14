import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { setAnalyticsUser, trackPageView } from '../lib/analytics';

// В SPA браузер не перезагружает страницу при переходах, поэтому автоматический page_view у GA4
// отключён (send_page_view: false в index.html) и просмотры шлём сами — на каждую смену маршрута,
// но только после того, как известна сессия, чтобы первый просмотр сразу был с user_id.
export function AnalyticsTracker() {
  const { session, loading } = useAuth();
  const { pathname } = useLocation();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (loading) return;
    setAnalyticsUser(userId);
  }, [loading, userId]);

  useEffect(() => {
    if (loading) return;
    trackPageView(pathname);
  }, [loading, pathname]);

  return null;
}
