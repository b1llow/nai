/**
 * Vitest stub for `cloudflare:workers` (used by workers-oauth-provider).
 * Also marks CIMD as safe so the provider's module-load check sees the flag.
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

export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  readonly ctx: ExecutionContext<Props>;
  readonly env: Env;

  constructor(ctx: ExecutionContext<Props>, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
