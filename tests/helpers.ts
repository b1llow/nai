import type { Env } from "../src/env";

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NAI_BASE_URL: "https://text.novelai.net",
    NAI_IMAGE_BASE_URL: "https://image.novelai.net",
    NAI_API_BASE_URL: "https://api.novelai.net",
    ...overrides,
  };
}

/**
 * Node vitest has no Workers `ExecutionContext`. The platform type includes
 * tracing/exports/abort which this stub does not implement.
 */
export function testExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}
