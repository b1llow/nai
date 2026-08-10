import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./types";
import { HttpError, openaiError } from "./errors";
import { handleChatCompletions } from "./chat";
import { handleResponses } from "./responses";
import { listModels, getModel } from "./models";
import { handleTokenCount } from "./tokenize";

const app = new Hono<AppEnv>();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    // Omit allowHeaders so Hono reflects Access-Control-Request-Headers
    // (OpenAI SDK browser clients send x-stainless-* / OpenAI-*).
    exposeHeaders: ["x-request-id"],
  }),
);

// Auth gate for all /v1/*
app.use("/v1/*", async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(header)) {
    throw openaiError(401, "Missing or invalid Authorization header", {
      type: "authentication_error",
      code: "invalid_api_key",
    });
  }
  c.set("auth", header);
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
        message: `Invalid URL (${c.req.method} ${c.req.path})`,
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
  console.error("Unhandled error:", err instanceof Error ? err.message : err);
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
