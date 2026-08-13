/** HTML-escape untrusted text before interpolating into the consent page. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function securityHeaders(setCookies: string[] = []): Headers {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src 'none'",
      "font-src 'none'",
      "script-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join("; "),
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
