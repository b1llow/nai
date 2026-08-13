# nai

OpenAI-compatible proxy in front of [NovelAI](https://novelai.net) text APIs. Runs on Cloudflare Workers (Hono).

Point any OpenAI SDK / client at this worker, pass your NovelAI access token as a Bearer key, and call the usual `/v1/*` endpoints.

## Why this proxy?

NovelAI exposes a text API that is *almost* OpenAI-shaped (`/oa/v1/...`), but not quite enough for the tools people already use:

- **Client ecosystem assumes OpenAI.** SillyTavern, Continue, OpenWebUI, LangChain, the official OpenAI SDKs, and countless scripts speak Chat Completions / Responses. Pointing them at NovelAI directly fails on path prefixes, extra fields, error shapes, or missing endpoints.
- **Wire format mismatches.** NovelAI SSE chunks carry NAI-only fields (`token_ids`, `processed_logprobs`, …). Some clients choke on unknown keys or non-standard `finish_reason` handling. This proxy strips those and normalizes envelopes.
- **Streaming vs non-stream.** Many clients request `stream: false`. NovelAI’s reliable path is streaming; the proxy always force-streams upstream and aggregates when the client wants a single JSON object.
- **Responses API gap.** Newer clients use `/v1/responses`. NovelAI does not implement that surface; the proxy maps a useful subset onto chat completions.
- **Browser CORS.** Browser builds of the OpenAI SDK send `x-stainless-*` (and sometimes `OpenAI-*`) headers. A correct preflight reflector is required; raw upstream often is not set up for arbitrary web origins.
- **Auth and errors in one place.** One Bearer token passthrough, OpenAI-shaped `401`/`429`/`5xx` envelopes, and clean cancel-on-disconnect so abandoned tabs do not keep billing upstream generation.

In short: keep using the NovelAI models you pay for, without rewriting every client or maintaining per-app adapters.

This project is **not** affiliated with NovelAI / Anlatan. You need your own NovelAI account and access token. Respect NovelAI’s terms of service.

## Endpoints

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/` | Service info |
| `GET` | `/health` | Liveness |
| `GET` | `/v1/models` | Model list (upstream, with static fallback) |
| `GET` | `/v1/models/:id` | Single model |
| `POST` | `/v1/chat/completions` | Chat Completions (stream + non-stream) |
| `POST` | `/v1/responses` | Responses API subset (stream + non-stream) |
| `POST` | `/v1/internal/token-count` | Token count (NovelAI-shaped) |
| `POST` | `/v1/tokenize` | Alias of token-count |

All `/v1/*` routes require:

```http
Authorization: Bearer <novelai-access-token>
```

The header is forwarded upstream unchanged.

## Supported models

Hardcoded fallback IDs (also used when the upstream models call fails non-auth):

- `xialong-v1`
- `glm-4-6`

Upstream `GET /oa/v1/models` is preferred when it succeeds. Auth failures (`401` / `403`) and rate limits (`429`) are returned to the client instead of masking with the fallback list.

## What works / what doesn’t

**Works**

- Chat Completions with string or text-part message content
- Streaming SSE and non-stream JSON (non-stream always force-streams upstream, then aggregates)
- Responses API text input / message items → chat messages
- OpenAI-shaped error envelopes (`invalid_request_error`, `authentication_error`, …)
- CORS for browser clients (including OpenAI JS SDK `x-stainless-*` headers)
- Client disconnect cancels the upstream NovelAI generation

**Rejected / not supported**

- Tools / function calling (empty `tools: []` is allowed)
- Multimodal content (images, audio, files)
- `n != 1`
- Responses: `previous_response_id`, `conversation`, `background`, `reasoning.effort`, non-message input items, `json_schema` / `json_object` formats

## Quick start

### Requirements

- Node.js 18+
- A NovelAI access token
- Cloudflare account (for deploy)

### Install

```bash
npm install
```

### Configure

`wrangler.jsonc` sets the default upstream:

```jsonc
"vars": {
  "NAI_BASE_URL": "https://text.novelai.net"
}
```

Override locally with `.dev.vars` (gitignored):

```bash
# .dev.vars
NAI_BASE_URL=https://text.novelai.net
```

### Dev

```bash
npm run dev
```

Wrangler prints a local URL (typically `http://127.0.0.1:8787`).

### Test / typecheck

```bash
npm test
npm run typecheck
```

### Deploy

```bash
npm run deploy
```

Custom domain in this repo: `nai.hoshinoaya.com` (see `wrangler.jsonc` `routes`).

## Client usage

### curl

```bash
export NAI_BASE=https://nai.hoshinoaya.com   # or http://127.0.0.1:8787
export NAI_TOKEN=your_novelai_access_token

curl "$NAI_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $NAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "xialong-v1",
    "messages": [{"role": "user", "content": "Hi"}],
    "stream": false
  }'
```

Streaming:

```bash
curl -N "$NAI_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $NAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4-6",
    "messages": [{"role": "user", "content": "Write a haiku"}],
    "stream": true
  }'
```

### OpenAI JS SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.NAI_TOKEN!,
  baseURL: "https://nai.hoshinoaya.com/v1",
});

const completion = await client.chat.completions.create({
  model: "xialong-v1",
  messages: [{ role: "user", content: "Hello" }],
});
```

### SillyTavern / other frontends

- API type: OpenAI-compatible
- Base URL: `https://nai.hoshinoaya.com/v1` (include `/v1`)
- API key: NovelAI access token

## Architecture

```
Client (OpenAI SDK / ST / curl)
        │  Bearer NAI token
        ▼
   Cloudflare Worker (Hono)
     auth gate → route handlers
        │
        ▼
   text.novelai.net  /oa/v1/*
```

| Area | Module |
|------|--------|
| Routing, CORS, auth, errors | `src/app.ts` |
| Chat Completions | `src/chat.ts` |
| Responses API mapping | `src/responses.ts` |
| Models list | `src/models.ts` |
| Token count | `src/tokenize.ts` |
| Upstream fetch | `src/upstream.ts` |
| SSE parse / aggregate / strip NAI fields | `src/sse.ts` |
| Message content flatten | `src/content.ts` |
| OpenAI error mapping | `src/errors.ts` |

Chat and Responses always request `stream: true` from NovelAI. Non-stream clients get a fully aggregated `chat.completion` / `response` object. Streaming clients receive stripped OpenAI-shaped SSE (`token_ids` and other NAI-only fields removed).

## Environment

| Binding | Required | Description |
|---------|----------|-------------|
| `NAI_BASE_URL` | yes | NovelAI text API origin. Must be `https://text.novelai.net` or `https://api.novelai.net` (default in wrangler: `https://text.novelai.net`) |
| `NAI_ALLOW_UNSAFE_BASE_URL` | no | Set to `1` only for local mocks; skips the host allowlist but still requires `http(s)` and rejects URLs with credentials |
| `API_RATE_LIMIT` | no | Cloudflare Rate Limiting binding (wrangler `ratelimits`); 120 requests / 60s per client IP on `/v1/*` |

Authenticated `/v1/*` responses set `Cache-Control: private, no-store`. POST bodies are capped at 2 MiB. Chat/Responses payloads cap message count, prompt size, and `max_tokens`.

No server-side API key is stored; callers supply the NovelAI token per request. Tokens must be printable ASCII Bearer credentials (8–4096 chars).

## License

[GPL-3.0-only](LICENSE) — see `LICENSE` for the full text.

```
nai — OpenAI-compatible NovelAI proxy
Copyright (C) 2026

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```
