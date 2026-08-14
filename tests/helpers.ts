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

async function toArrayBuffer(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
): Promise<ArrayBuffer> {
  if (value == null) return new ArrayBuffer(0);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
  }
  return new Response(value as BodyInit).arrayBuffer();
}

function r2Object(
  key: string,
  row: {
    body: ArrayBuffer;
    httpMetadata?: R2HTTPMetadata;
    customMetadata?: Record<string, string>;
    uploaded: Date;
    etag: string;
  },
): R2ObjectBody {
  return {
    key,
    version: row.etag,
    size: row.body.byteLength,
    etag: row.etag,
    httpEtag: `"${row.etag}"`,
    checksums: { toJSON: () => ({}) },
    uploaded: row.uploaded,
    httpMetadata: row.httpMetadata,
    customMetadata: row.customMetadata,
    storageClass: "Standard",
    writeHttpMetadata() {},
    get body() {
      return new Blob([row.body]).stream();
    },
    bodyUsed: false,
    arrayBuffer: async () => row.body.slice(0),
    bytes: async () => new Uint8Array(row.body.slice(0)),
    text: async () => new TextDecoder().decode(row.body),
    json: async <T>() => JSON.parse(new TextDecoder().decode(row.body)) as T,
    blob: async () => new Blob([row.body]),
  } as unknown as R2ObjectBody;
}

export function memoryR2(): R2Bucket {
  const store = new Map<
    string,
    {
      body: ArrayBuffer;
      httpMetadata?: R2HTTPMetadata;
      customMetadata?: Record<string, string>;
      uploaded: Date;
      etag: string;
    }
  >();

  return {
    put: async (
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      options?: R2PutOptions,
    ) => {
      const body = await toArrayBuffer(value);
      const etag = crypto.randomUUID().replace(/-/g, "");
      const httpMetadata =
        options?.httpMetadata instanceof Headers
          ? { contentType: options.httpMetadata.get("content-type") ?? undefined }
          : options?.httpMetadata;
      const row = {
        body,
        httpMetadata,
        customMetadata: options?.customMetadata,
        uploaded: new Date(),
        etag,
      };
      store.set(key, row);
      return r2Object(key, row);
    },
    get: async (key: string) => {
      const row = store.get(key);
      return row ? r2Object(key, row) : null;
    },
    head: async (key: string) => {
      const row = store.get(key);
      return row ? r2Object(key, row) : null;
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
    list: async () => ({
      objects: [],
      truncated: false,
    }),
  } as unknown as R2Bucket;
}

export function stubImages(
  encode: (bytes: Uint8Array) => Uint8Array = (bytes) => bytes,
): ImagesBinding {
  return {
    input(stream: ReadableStream<Uint8Array>) {
      const transformer = {
        transform() {
          return transformer;
        },
        draw() {
          return transformer;
        },
        async output(options: ImageOutputOptions) {
          const buf = new Uint8Array(await new Response(stream).arrayBuffer());
          const out = encode(buf);
          const response = new Response(out, {
            headers: { "content-type": options.format },
          });
          return {
            response: () => response,
            contentType: () => options.format,
            image: () => new Blob([out]).stream(),
          };
        },
      };
      return transformer;
    },
    info: async () => ({ format: "image/png" as const, fileSize: 0, width: 1, height: 1 }),
    hosted: {} as HostedImagesBinding,
  } as unknown as ImagesBinding;
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NAI_BASE_URL: "https://text.novelai.net",
    NAI_IMAGE_BASE_URL: "https://image.novelai.net",
    NAI_API_BASE_URL: "https://api.novelai.net",
    OAUTH_KV: memoryKv(),
    IMG_BUCKET: memoryR2(),
    IMAGES: stubImages(),
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
