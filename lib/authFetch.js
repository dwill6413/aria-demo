// ─── Shared session-aware fetch (Phase 2c) ────────────────────────────────────
// Previously this exact pair of functions was hand-copied into six pages
// (index.jsx, host.jsx, bookings.jsx, ai.jsx, become-host.jsx, messages.jsx) —
// byte-for-byte identical in all six. Centralizing it here means the
// session-header logic (and any future fix to it, e.g. token refresh) only
// has to be made once instead of mirrored six times.
//
// getStoredSid: reads the fallback session id from localStorage. This is only
// needed because some browser contexts (e.g. third-party cookie blocking)
// won't reliably send the aria_session cookie — x-session-id is the fallback
// the backend also accepts (see server.mjs / ai_route.mjs session lookups:
// `request.cookies.aria_session || request.headers['x-session-id']`).
export const getStoredSid = () => {
  try { return localStorage.getItem('aria_sid') || ''; } catch { return ''; }
};

// authFetch: wraps fetch() to always send cookies AND the x-session-id
// fallback header, so every authenticated call from any page behaves
// identically regardless of cookie availability.
export const authFetch = (url, options = {}) => {
  const sid = getStoredSid();
  const headers = { ...(options.headers || {}) };
  if (sid) headers['x-session-id'] = sid;
  return fetch(url, { ...options, credentials: 'include', headers });
};
