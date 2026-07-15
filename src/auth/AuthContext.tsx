import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { withRetry } from '../lib/db';

type AuthState = {
  session: Session | null;
  loading: boolean;
  isMember: boolean;
  isAdmin: boolean;
  membershipError: boolean;
  refreshMembership: () => Promise<void>;
  signOut: () => Promise<void>;
};
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isMember, setIsMember] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [membershipError, setMembershipError] = useState(false);

  async function loadMembership(s: Session | null) {
    if (!s) {
      setIsMember(false);
      setIsAdmin(false);
      setMembershipError(false);
      return;
    }
    try {
      const { data, error } = await withRetry(async () =>
        supabase.from('users').select('is_admin').eq('id', s.user.id).maybeSingle(),
      );
      if (error) throw error;
      setIsMember(!!data);
      setIsAdmin(!!data?.is_admin);
      setMembershipError(false);
    } catch {
      // Транзиентный сетевой сбой (после исчерпания ретраев) -> не значит "не участник",
      // просто не смогли проверить. ProtectedRoute покажет "Повторить" вместо /redeem.
      setMembershipError(true);
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await loadMembership(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      setSession(s);
      await loadMembership(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const value: AuthState = {
    session,
    loading,
    isMember,
    isAdmin,
    membershipError,
    refreshMembership: () => loadMembership(session),
    signOut: async () => {
      await supabase.auth.signOut();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth вне AuthProvider');
  return v;
}
