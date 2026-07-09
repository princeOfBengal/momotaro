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
    } catch (err) {
      // Clear the stored token only when the USER layer says the session is
      // dead. /api/users/me sits behind the device gate
      // (requireClientOrAdmin), which emits its own 401s — 'Authentication
      // required' / 'Invalid or revoked token' — when the *pairing* is
      // missing or revoked. Those say nothing about the user session: a
      // revoked device that re-pairs should resume its login, not be forced
      // through it again. The body match is coupled to the message in
      // server/src/middleware/userAuth.js (requireUser) — keep in sync.
      // Network failures (offline boot, server down) carry no `.status` and
      // must keep the token too: the session may still be valid once the
      // server is reachable again.
      if (err?.status === 401 && err?.body?.error === 'User authentication required') {
        api.clearUserToken();
      }
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
