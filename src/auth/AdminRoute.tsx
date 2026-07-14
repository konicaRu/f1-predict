import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

// Клиентский гейт админки (сервер защищён RLS; это UX — не пускать не-админа на /admin).
export function AdminRoute({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/calendar" replace />;
  return <>{children}</>;
}
