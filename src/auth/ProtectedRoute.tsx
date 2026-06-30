import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, isMember, loading } = useAuth();
  if (loading) return <div style={{ padding: 24, color: '#fff' }}>Загрузка…</div>;
  if (!session) return <Navigate to="/login" replace />;
  if (!isMember) return <Navigate to="/redeem" replace />;
  return <>{children}</>;
}
