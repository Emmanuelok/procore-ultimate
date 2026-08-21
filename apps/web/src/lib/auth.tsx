import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api, tokenStore } from "./api";

export interface AuthCompany {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  companies: AuthCompany[];
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  companyId: string | null;
  company: AuthCompany | null;
  setCompanyId: (id: string) => void;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    name: string;
    companyName: string;
  }) => Promise<void>;
  logout: () => void;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [companyId, setCompanyIdState] = useState<string | null>(tokenStore.companyId);

  const reload = useCallback(async () => {
    if (!tokenStore.access) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api.get<AuthUser>("/api/v1/me");
      setUser(me);
      const stored = tokenStore.companyId;
      const valid = me.companies.find((c) => c.id === stored);
      const chosen = valid ?? me.companies[0];
      if (chosen) {
        tokenStore.setCompany(chosen.id);
        setCompanyIdState(chosen.id);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.post<{ accessToken: string; refreshToken: string }>(
        "/api/v1/auth/login",
        { email, password },
      );
      tokenStore.set(res);
      await reload();
    },
    [reload],
  );

  const register = useCallback(
    async (input: { email: string; password: string; name: string; companyName: string }) => {
      const res = await api.post<{
        accessToken: string;
        refreshToken: string;
        company: { id: string } | null;
      }>("/api/v1/auth/register", input);
      tokenStore.set(res);
      if (res.company) tokenStore.setCompany(res.company.id);
      await reload();
    },
    [reload],
  );

  const logout = useCallback(() => {
    const refreshToken = tokenStore.refresh;
    if (refreshToken) {
      void api.post("/api/v1/auth/logout", { refreshToken }).catch(() => undefined);
    }
    tokenStore.clear();
    setUser(null);
    setCompanyIdState(null);
  }, []);

  const setCompanyId = useCallback((id: string) => {
    tokenStore.setCompany(id);
    setCompanyIdState(id);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      companyId,
      company: user?.companies.find((c) => c.id === companyId) ?? null,
      setCompanyId,
      login,
      register,
      logout,
      reload,
    }),
    [user, loading, companyId, setCompanyId, login, register, logout, reload],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-400">Loading…</div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
