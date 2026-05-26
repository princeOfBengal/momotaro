import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

/**
 * Holds the logged-in user (multi-user mode) and exposes login / register /
 * logout. On mount it hydrates from `GET /api/users/me` if a stored session
 * token exists. In single-user / pre-accounts installs there is no token, so
 * `user` stays null and the rest of the app behaves exactly as before — the
 * server resolves every request to the default user regardless.
 *
 * This is identity only; it is intentionally independent of connectivity and
 * of the device-pairing layer.
 */

const UserContext = createContext(null);

export function UserProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!api.getUserToken()) {
      setUser(null);
      setLoading(false);
      return null;
    }
    try {
      const me = await api.getMe();
      setUser(me);
      if (me?.id != null) api.setActiveUserId(me.id);
      return me;
    } catch {
      // Token invalid/expired/offline — treat as logged out. A stale token is
      // cleared so the gate routes to /login instead of looping.
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback(async (username, password) => {
    const data = await api.login(username, password); // throws on failure
    setUser(data.user);
    return data;
  }, []);

  const register = useCallback(async (username, password, displayName) => {
    const data = await api.register(username, password, displayName);
    setUser(data.user);
    return data;
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } finally { setUser(null); }
  }, []);

  return (
    <UserContext.Provider value={{ user, loading, refresh, login, register, logout }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser must be used within a UserProvider');
  return ctx;
}
