import type { Env } from "../src/env";

export function memoryKv(): KVNamespace {
  const store = new Map<string, { value: string; exp?: number }>();

  const alive = (key: string): string | null => {
    const row = store.get(key);
    if (!row) return null;
    if (row.exp && Date.now() / 1000 > row.exp) {
      store.delete(key);
      return null;
    }
    return row.value;
  };

  return {
    get: async (key: string, typeOrOpts?: string | { type?: string }) => {
      const value = alive(key);
      if (value === null) return null;
      const type =
        typeof typeOrOpts === "string" ? typeOrOpts : typeOrOpts?.type;
      if (type === "json") return JSON.parse(value);
      if (type === "arrayBuffer") {
        return new TextEncoder().encode(value).buffer;
      }
      return value;
    },
    put: async (
      key: string,
      value: string | ArrayBuffer,
      opts?: { expirationTtl?: number; expiration?: number },
    ) => {
      const str =
        typeof value === "string" ? value : new TextDecoder().decode(value);
      const exp =
        opts?.expiration ??
        (opts?.expirationTtl
          ? Math.floor(Date.now() / 1000) + opts.expirationTtl
          : undefined);
      store.set(key, { value: str, exp });
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const names = [...store.keys()]
        .filter((k) => k.startsWith(prefix) && alive(k) !== null)
        .sort();
      return {
        keys: names.map((name) => ({ name })),
        list_complete: true as const,
        cacheStatus: null,
      };
    },
    getWithMetadata: async (key: string) => ({
      value: alive(key),
      metadata: null,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NAI_BASE_URL: "https://text.novelai.net",
    NAI_IMAGE_BASE_URL: "https://image.novelai.net",
    NAI_API_BASE_URL: "https://api.novelai.net",
    OAUTH_KV: memoryKv(),
    ...overrides,
  };
}

/**
 * Node vitest has no Workers `ExecutionContext`. The platform type includes
 * tracing/exports/abort which this stub does not implement.
 */
export function testExecutionContext(props: unknown = {}): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props,
  } as unknown as ExecutionContext;
}
