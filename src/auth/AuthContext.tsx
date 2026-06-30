import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

type AuthState = {
  session: Session | null;
  loading: boolean;
  isMember: boolean;
  isAdmin: boolean;
  refreshMembership: () => Promise<void>;
  signOut: () => Promise<void>;
};
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isMember, setIsMember] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  async function loadMembership(s: Session | null) {
    if (!s) {
      setIsMember(false);
      setIsAdmin(false);
      return;
    }
    const { data } = await supabase.from('users').select('is_admin').eq('id', s.user.id).maybeSingle();
    setIsMember(!!data);
    setIsAdmin(!!data?.is_admin);
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
