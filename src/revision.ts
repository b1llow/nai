const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Git commit baked in by `npm run deploy` (`--var GIT_SHA`). */
export function workerRevision(env: { GIT_SHA?: string }): string | null {
  const raw = env.GIT_SHA?.trim() ?? "";
  return GIT_SHA_RE.test(raw) ? raw.toLowerCase() : null;
}

export function healthPayload(env: { GIT_SHA?: string }): {
  ok: true;
  revision: string | null;
} {
  return { ok: true, revision: workerRevision(env) };
}
