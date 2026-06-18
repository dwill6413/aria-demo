// ─── Email helpers (R14) ──────────────────────────────────────────────────────
// escapeHtml: HTML-escape any value before interpolating it into an email
// template. The booking/claim/dispute emails interpolate user-controlled free
// text — most importantly the claim/dispute `reason` fields, but also guest
// names and (forward-looking) any message content — directly into HTML strings.
// Without escaping, a crafted reason like `<img src=x onerror=...>` or a
// link-injection rides into the email ARIA sends to the guest or admin. Email
// clients sandbox scripts, but markup/link/style injection and content spoofing
// are still real, so escape every dynamic field at interpolation time.
//
// This is the minimal R14 step (escape dynamic fields); a fuller template
// module is a separate, lower-priority refactor.
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
