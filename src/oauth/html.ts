/** HTML-escape untrusted text before interpolating into the consent page. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Consent-page CSP.
 *
 * Do not set `form-action`: Chrome applies it to the entire redirect chain
 * after the POST (chatgpt.com / claude.ai, then sometimes `claude://`).
 * `form-action 'self'` therefore blocks completing OAuth.
 *
 * `script-src 'none'` also breaks Cloudflare managed challenges (`/cdn-cgi/`
 * and `challenges.cloudflare.com`); CF may inject a nonce which makes `'none'`
 * ignored and still blocks Zaraz / jsd.
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "img-src 'self' data:",
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join("; ");
}

export function securityHeaders(setCookies: string[] = []): Headers {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": contentSecurityPolicy(),
  });
  for (const cookie of setCookies) {
    headers.append("Set-Cookie", cookie);
  }
  return headers;
}

export function htmlResponse(
  status: number,
  body: string,
  setCookies: string[] = [],
): Response {
  return new Response(body, { status, headers: securityHeaders(setCookies) });
}
