import type { Env } from "../src/env";

type KvRow = {
  value: string | ArrayBuffer;
  exp?: number;
  metadata?: unknown;
};

function copyBuffer(value: ArrayBuffer): ArrayBuffer {
  return value.slice(0);
}

function asString(value: string | ArrayBuffer): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function asBuffer(value: string | ArrayBuffer): ArrayBuffer {
  if (typeof value !== "string") return copyBuffer(value);
  const bytes = new TextEncoder().encode(value);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function getType(
  typeOrOpts?: string | { type?: string },
): string | undefined {
  return typeof typeOrOpts === "string" ? typeOrOpts : typeOrOpts?.type;
}

export function memoryKv(): KVNamespace {
  const store = new Map<string, KvRow>();

  const alive = (key: string): KvRow | null => {
    const row = store.get(key);
    if (!row) return null;
    if (row.exp && Date.now() / 1000 > row.exp) {
      store.delete(key);
      return null;
    }
    return row;
  };

  const readValue = (row: KvRow, type?: string): unknown => {
    if (type === "json") return JSON.parse(asString(row.value));
    if (type === "arrayBuffer") return asBuffer(row.value);
    return asString(row.value);
  };

  return {
    get: async (key: string, typeOrOpts?: string | { type?: string }) => {
      const row = alive(key);
      if (!row) return null;
      return readValue(row, getType(typeOrOpts));
    },
    put: async (
      key: string,
      value: string | ArrayBuffer,
      opts?: {
        expirationTtl?: number;
        expiration?: number;
        metadata?: unknown;
      },
    ) => {
      const stored =
        typeof value === "string" ? value : copyBuffer(value);
      const exp =
        opts?.expiration ??
        (opts?.expirationTtl
          ? Math.floor(Date.now() / 1000) + opts.expirationTtl
          : undefined);
      store.set(key, { value: stored, exp, metadata: opts?.metadata });
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
    getWithMetadata: async (
      key: string,
      typeOrOpts?: string | { type?: string },
    ) => {
      const row = alive(key);
      if (!row) {
        return { value: null, metadata: null, cacheStatus: null };
      }
      return {
        value: readValue(row, getType(typeOrOpts)),
        metadata: row.metadata ?? null,
        cacheStatus: null,
      };
    },
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
