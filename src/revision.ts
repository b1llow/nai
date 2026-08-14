const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Replaced at deploy by `wrangler --define`. Undeclared in tests / `wrangler dev`. */
declare const __NAI_REVISION__: string | undefined;

export function parseRevision(raw: string | undefined | null): string | null {
  const value = raw?.trim() ?? "";
  return GIT_SHA_RE.test(value) ? value.toLowerCase() : null;
}

export function workerRevision(): string | null {
  const defined = typeof __NAI_REVISION__ === "string" ? __NAI_REVISION__ : "";
  return parseRevision(defined);
}

export function healthPayload(): { ok: true; revision: string | null } {
  return { ok: true, revision: workerRevision() };
}
