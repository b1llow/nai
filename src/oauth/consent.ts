import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { OAUTH_CONSENT_TTL_SECONDS } from "../limits";

const KV_PREFIX = "consent:";

export type ConsentRecord = {
  request: AuthRequest;
  csrf: string;
};

export type CookieNames = {
  csrf: string;
  consent: string;
  flags: string;
};

export function cookieNames(url: URL): CookieNames {
  const https = url.protocol === "https:";
  const flags = https
    ? "HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600"
    : "HttpOnly; Path=/; SameSite=Lax; Max-Age=600";
  return {
    csrf: https ? "__Host-OAUTH_CSRF" : "OAUTH_CSRF",
    consent: https ? "__Host-OAUTH_CONSENT" : "OAUTH_CONSENT",
    flags,
  };
}

export function clearCookie(name: string, url: URL): string {
  const https = url.protocol === "https:";
  const flags = https
    ? "HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0"
    : "HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
  return `${name}=; ${flags}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const value = trimmed.slice(name.length + 1);
    return value || null;
  }
  return null;
}

export async function putConsent(
  kv: KVNamespace,
  consentId: string,
  record: ConsentRecord,
): Promise<void> {
  await kv.put(`${KV_PREFIX}${consentId}`, JSON.stringify(record), {
    expirationTtl: OAUTH_CONSENT_TTL_SECONDS,
  });
}

export async function takeConsent(
  kv: KVNamespace,
  consentId: string,
): Promise<ConsentRecord | null> {
  const key = `${KV_PREFIX}${consentId}`;
  const raw = await kv.get(key, "json");
  await kv.delete(key);
  return parseConsentRecord(raw);
}

function parseConsentRecord(raw: unknown): ConsentRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { request?: AuthRequest; csrf?: unknown };
  if (!rec.request || typeof rec.csrf !== "string" || !rec.csrf) return null;
  if (typeof rec.request.clientId !== "string") return null;
  if (typeof rec.request.redirectUri !== "string") return null;
  return { request: rec.request, csrf: rec.csrf };
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
