import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./types";
import { HttpError, openaiError } from "./errors";
import { handleChatCompletions } from "./chat";
import { handleResponses } from "./responses";
import { listModels, getModel } from "./models";
import { handleTokenCount } from "./tokenize";
import { parseAuthorization } from "./auth";
import { MAX_BODY_BYTES, safeIdent } from "./limits";

const app = new Hono<AppEnv>();

const CORS_HEADERS = [
  "Authorization",
  "Content-Type",
  "Accept",
  "OpenAI-Beta",
  "OpenAI-Organization",
  "OpenAI-Project",
  "OpenAI-Request-ID",
  "x-api-key",
  "x-stainless-arch",
  "x-stainless-async",
  "x-stainless-custom-poll-interval",
  "x-stainless-helper-method",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-poll-helper",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
];

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
});

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    // Explicit list avoids the default CORS ReDoS path (CVE-2026-69207) and
    // still covers OpenAI JS SDK browser preflights (x-stainless-* / OpenAI-*).
    allowHeaders: CORS_HEADERS,
    exposeHeaders: ["x-request-id"],
  }),
);

app.use("/v1/*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});

app.use("/v1/*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const limiter = c.env.API_RATE_LIMIT;
  if (!limiter) return next();
  const ip =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    "unknown";
  try {
    const { success } = await limiter.limit({ key: ip });
    if (!success) {
      throw openaiError(429, "Rate limit exceeded", {
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        headers: { "Retry-After": "60" },
      });
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Binding missing or platform error: fail open so a limiter outage is not a 500.
  }
  await next();
});

app.use("/v1/*", async (c, next) => {
  if (c.req.method !== "POST") return next();
  return bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw openaiError(413, "Request body too large", {
        type: "invalid_request_error",
      });
    },
  })(c, next);
});

app.use("/v1/*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  c.set("auth", parseAuthorization(c.req.header("Authorization")));
  await next();
});

app.get("/", (c) =>
  c.json({
    name: "nai-openai-proxy",
    endpoints: [
      "/v1/models",
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/internal/token-count",
    ],
  }),
);

app.get("/health", (c) => c.json({ ok: true }));

app.get("/v1/models", listModels);
app.get("/v1/models/:id", getModel);
app.post("/v1/chat/completions", handleChatCompletions);
app.post("/v1/responses", handleResponses);
app.post("/v1/internal/token-count", handleTokenCount);
app.post("/v1/tokenize", handleTokenCount);

app.notFound((c) =>
  c.json(
    {
      error: {
        message: `Invalid URL (${c.req.method} ${safeIdent(c.req.path, 128)})`,
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    },
    404,
  ),
);

app.onError((err, c) => {
  if (err instanceof HttpError) {
    for (const [k, v] of Object.entries(err.headers)) {
      c.header(k, v);
    }
    return c.json(err.toJSON(), err.status as 400);
  }
  console.error({
    message: "unhandled error",
    error: err instanceof Error ? err.message : "non-error thrown",
    path: c.req.path,
  });
  return c.json(
    {
      error: {
        message: "Internal Server Error",
        type: "api_error",
        param: null,
        code: "internal_error",
      },
    },
    500,
  );
});

export default app;
