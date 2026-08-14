import { BAKED_REVISION } from "./baked-revision";

const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

export function parseRevision(raw: string | undefined | null): string | null {
  const value = raw?.trim() ?? "";
  return GIT_SHA_RE.test(value) ? value.toLowerCase() : null;
}

export function workerRevision(): string | null {
  return parseRevision(BAKED_REVISION);
}

export function healthPayload(): { ok: true; revision: string | null } {
  return { ok: true, revision: workerRevision() };
}
