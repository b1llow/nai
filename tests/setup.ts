/**
 * workers-oauth-provider advertises CIMD only when this runtime flag is set.
 * Wrangler sets it from wrangler.jsonc; Node tests do not.
 */
const g = globalThis as typeof globalThis & {
  Cloudflare?: { compatibilityFlags?: Record<string, boolean> };
};
g.Cloudflare = {
  ...g.Cloudflare,
  compatibilityFlags: {
    ...g.Cloudflare?.compatibilityFlags,
    global_fetch_strictly_public: true,
  },
};
