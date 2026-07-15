import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, isMember, membershipError, loading, refreshMembership } = useAuth();
  if (loading) return <div style={{ padding: 24, color: '#fff' }}>Загрузка…</div>;
  if (!session) return <Navigate to="/login" replace />;
  if (membershipError)
    return (
      <div className="stub">
        <p>Не удалось проверить доступ — проблема с сетью.</p>
        <button className="retry-btn" onClick={refreshMembership}>Повторить</button>
      </div>
    );
  if (!isMember) return <Navigate to="/redeem" replace />;
  return <>{children}</>;
}
