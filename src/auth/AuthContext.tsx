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
    async function init() {
      const tg = (window as any).Telegram?.WebApp;
      const initData: string | undefined = tg?.initData;
      if (initData) {
        try {
          const { data, error } = await supabase.functions.invoke('telegram-auth', {
            body: { initData },
            timeout: 10000,
          });
          if (!error && data?.access_token && data?.refresh_token) {
            await supabase.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
          }
        } catch {
          // Обмен не удался -> просто продолжаем как обычный неавторизованный визит (см. ниже).
        }
      }
      const { data: sessionData } = await supabase.auth.getSession();
      setSession(sessionData.session);
      await loadMembership(sessionData.session);
      setLoading(false);
    }
    init();
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
