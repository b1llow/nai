# nai

OpenAI-compatible proxy **and** remote MCP server in front of [NovelAI](https://novelai.net). Runs on Cloudflare Workers (Hono + `createMcpHandler`).

- Point any OpenAI SDK / client at `/v1/*`, pass your NovelAI access token as a Bearer key.
- Point an MCP client at `/mcp` for image generation, Director tools, story text, TTS, and account queries.

This project is **not** affiliated with NovelAI / Anlatan. You need your own NovelAI account and **Persistent API token**. Respect NovelAI’s terms of service. Third-party clients must not collect NovelAI email/password.

## Why this proxy?

NovelAI exposes a text API that is *almost* OpenAI-shaped (`/oa/v1/...`), but not quite enough for the tools people already use:

- **Client ecosystem assumes OpenAI.** SillyTavern, Continue, OpenWebUI, LangChain, the official OpenAI SDKs, and countless scripts speak Chat Completions / Responses. Pointing them at NovelAI directly fails on path prefixes, extra fields, error shapes, or missing endpoints.
- **Wire format mismatches.** NovelAI SSE chunks carry NAI-only fields (`token_ids`, `processed_logprobs`, …). Some clients choke on unknown keys or non-standard `finish_reason` handling. This proxy strips those and normalizes envelopes.
- **Streaming vs non-stream.** Many clients request `stream: false`. NovelAI’s reliable path is streaming; the proxy always force-streams upstream and aggregates when the client wants a single JSON object.
- **Responses API gap.** Newer clients use `/v1/responses`. NovelAI does not implement that surface; the proxy maps a useful subset onto chat completions.
- **Browser CORS.** Browser builds of the OpenAI SDK send `x-stainless-*` (and sometimes `OpenAI-*`) headers. A correct preflight reflector is required; raw upstream often is not set up for arbitrary web origins.
- **Auth and errors in one place.** One Bearer token passthrough, OpenAI-shaped `401`/`429`/`5xx` envelopes, and clean cancel-on-disconnect so abandoned tabs do not keep billing upstream generation.

In short: keep using the NovelAI models you pay for, without rewriting every client or maintaining per-app adapters.

## Endpoints

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/` | Service info |
| `GET` | `/health` | Liveness. JSON `{ ok, revision }` — `revision` is the git SHA stamped before the Worker is bundled (`null` only if install/deploy could not resolve a SHA) |
| `GET` | `/i/:file` | Public generated image (WebP, or PNG fallback). Capability URL; no auth |
| `POST`/`GET` | `/mcp` | Remote MCP (Streamable HTTP). OAuth or NovelAI Bearer |
| `GET`/`POST` | `/authorize` | MCP OAuth consent (paste Persistent API token) |
| `POST` | `/oauth/token` | OAuth token + refresh |
| `POST` | `/oauth/register` | OAuth dynamic client registration |
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

## MCP server

`POST https://nai.hoshinoaya.com/mcp` (Streamable HTTP).

ChatGPT Cloud and other remote MCP hosts **cannot** set a custom `Authorization` header. This Worker is an OAuth 2.1 authorization server (PKCE S256, CIMD + DCR, refresh tokens). On `/authorize`, paste a NovelAI Persistent API token. The grant stores that token encrypted in Workers KV (`OAUTH_KV`) and issues ChatGPT its own access token. Completing OAuth does **not** send your NovelAI email or password to this Worker.

Protected resource metadata pins `resource` to the request origin plus `/mcp` for hosts this Worker serves (`nai.hoshinoaya.com`, loopback, `*.workers.dev`). ChatGPT should use `https://nai.hoshinoaya.com/mcp`. Dynamic client registration only accepts loopback URLs, ChatGPT connector OAuth callbacks, Claude's `https://claude.ai/api/mcp/auth_callback`, and Grok's `https://grok.com/connectors-oauth-exchange-code/`. The consent page shows the client name (default **an MCP client**, never assumed to be ChatGPT), `client_id`, and `redirect_uri` so you can confirm the callback before pasting a token.

### ChatGPT (Developer Mode)

1. Enable Developer mode in ChatGPT (Settings → Apps).
2. Create a connector / app whose MCP URL is `https://nai.hoshinoaya.com/mcp`.
3. When ChatGPT opens the authorization page, paste a NovelAI **Persistent API token** from NovelAI account settings and approve.
4. ChatGPT refreshes access with `offline_access`; you should not need to paste the token on every chat.

Create a persistent token in the NovelAI account settings. Do not send email/password to this worker. Do not put a NovelAI token in a Worker secret: this URL is public, and a shared fallback token would let anyone use your account.

### Grok (grok.com Custom Connector)

Grok does not perform dynamic client registration — its Custom Connector form asks for a pre-issued Client ID. This Worker writes a public PKCE client (`grok-connector`) into `OAUTH_KV` without the 90-day DCR TTL, so the same ID stays valid. Do not mint a Grok client via `POST /oauth/register`: those records expire and saved connectors then fail with an unknown client.

At [grok.com/connectors](https://grok.com/connectors) → New Connector → Custom:

1. Server URL: `https://nai.hoshinoaya.com/mcp` (the MCP endpoint, **not** `/authorize`).
2. When Grok shows **OAuth Credentials Required**: Client ID = `grok-connector`, Client Secret = leave blank, PKCE = S256.
3. Complete sign-in on `/authorize` by pasting a NovelAI Persistent API token.

The `client_id` is a public identifier (no secret; every user authorizes it separately).

### Cursor / Claude Desktop

Clients that can set HTTP headers may still pass the NovelAI token on each MCP request (same as `/v1`):

```http
Authorization: Bearer <token>
```

That compatibility path is token passthrough, not the MCP OAuth profile. Prefer OAuth when the client supports it (`mcp-remote` without `--header` will open a browser). Header injection still works:

```json
{
  "mcpServers": {
    "novelai": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://nai.hoshinoaya.com/mcp",
        "--header",
        "Authorization: Bearer ${NAI_TOKEN}"
      ]
    }
  }
}
```

### Tools

| Tool | Upstream |
|------|----------|
| `nai_generate_image` | `image.novelai.net` `/ai/generate-image` (txt2img / img2img / infill, V4.5 characters, vibe, director reference). Returns `image_url` + `image_id`. |
| `nai_upscale` | `api.novelai.net` `/ai/upscale`. Accepts `image_id` or PNG base64. Returns `image_url` + `image_id`. |
| `nai_director` | `image.novelai.net` `/ai/augment-image`. Accepts `image_id` or PNG base64. Returns `image_url` + `image_id`. |
| `nai_get_image` | Reload a stored image by `image_id` (re-publishes the public URL if needed) |
| `nai_render_image_preview` | ChatGPT / MCP Apps render tool. Pass `image_id` from a previous image tool to mount `ui://novelai/image-preview-v3.html`. |
| `nai_suggest_tags` | `/ai/generate-image/suggest-tags` |
| `nai_encode_vibe` | `/ai/encode-vibe`. Returns `vibe_id` (token stays server-side; repeats are cached). |
| `nai_chat` | existing OpenAI-compatible chat proxy |
| `nai_generate_text` | `text.novelai.net` `/ai/generate` |
| `nai_tokenize` | `/oa/v1/internal/token-count` |
| `nai_generate_voice` | `/ai/generate-voice` |
| `nai_subscription` | `image.novelai.net` `/user/subscription` |
| `nai_list_models` | default text (OA `/oa/v1/models`); `kind=image` static catalog |

Resources: `nai://catalog/image-models`, `nai://catalog/resolutions`, `nai://catalog/samplers`, `nai://catalog/uc-presets`, `nai://image/{image_id}` (original PNGs for tool chaining; not listed), and `ui://novelai/image-preview-v3.html` (MCP App / ChatGPT output template for inline image preview).

Prompts: `txt2img_v45`, `multi_character`, `story_continue`.

Image tools return a public `image_url` (`https://nai.hoshinoaya.com/i/img_<id>.webp`) plus an `image_id` / `nai://image/...` handle for later tool calls. Clients can render the URL with a normal `<img src>` or markdown image. Pass that `image_id` to `nai_upscale`, `nai_director`, `nai_encode_vibe`, `nai_get_image`, `nai_render_image_preview`, or img2img — not a filename such as `image_0.png`, and not image bytes. Original PNGs live in R2 (`orig/<id>.png`), scoped to the NovelAI token, and never expire. The public WebP (quality 99) is a separate R2 object served by `GET /i/:file` with `Cache-Control: public, max-age=31536000, immutable`. URLs are capability URLs (128-bit `img_` id, no auth). If R2 or the Images binding is unavailable, tools fall back to PNG ImageContent.

V4 vibe PNGs are encoded through `/ai/encode-vibe` (2 Anlas per unique encode) unless you pass a `vibe_id` or `encoded=true`. Identical PNG+model+`information_extracted` encodes are cached in KV. Default image model is `nai-diffusion-4-5-full`. `n_samples` is capped at 4.

Only `nai_render_image_preview` advertises `_meta.ui.resourceUri` and `openai/outputTemplate` pointing at that widget (OpenAI’s decoupled data/render pattern). Generate / upscale / director / get-image are data tools: they return `image_url` and `image_id` and do not bind the template. After those tools succeed, the model should call `nai_render_image_preview` with the `image_id` — hosts cannot open `ui://` URIs, and `_meta` on a data-tool result is not model-visible. The render tool also copies the template URI onto the tool-result `_meta` plus `mcp_tool_result` / `call_tool_result` so ChatGPT can mount the iframe. The view completes the MCP Apps `ui/initialize` handshake before the host sends `ui/notifications/tool-result`. The widget resource sets `_meta.ui.domain` / `openai/widgetDomain` to `https://nai.hoshinoaya.com` so ChatGPT can submit the connector (unique sandbox origin), and allows that origin in the widget CSP `resourceDomains` so the preview can load the public URL. The widget prefers `structuredContent.images[].url` and falls back to base64 image blocks. It shows tool errors instead of a false “image was hidden” status.

Not implemented: login/register, encrypted story objects / keystore, module training, `/ai/classify`, stepwise image streaming.

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
  "NAI_BASE_URL": "https://text.novelai.net",
  "NAI_IMAGE_BASE_URL": "https://image.novelai.net",
  "NAI_API_BASE_URL": "https://api.novelai.net"
}
```

Override locally with `.dev.vars` (gitignored):

```bash
# .dev.vars
NAI_BASE_URL=https://text.novelai.net
NAI_IMAGE_BASE_URL=https://image.novelai.net
NAI_API_BASE_URL=https://api.novelai.net
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

Local publish (optional):

```bash
npm run deploy
```

Production deploys are **Cloudflare Workers Builds**, not GitHub Actions. GitHub Actions (`.github/workflows/ci.yml`) only runs typecheck and tests.

The dashboard Worker is already named `nai`, matching `wrangler.jsonc`. Connect the GitHub repo once:

1. Open [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) → **nai** → **Settings** → **Builds** → **Connect**
2. Authorize the [Cloudflare Workers & Pages GitHub App](https://github.com/apps/cloudflare-workers-and-pages) if prompted, and grant access to `b1llow/nai`
3. Production branch: `main`. Leave the build command empty. The default deploy command `npx wrangler deploy` is enough: Workers Builds runs `npm clean-install` first, and `postinstall` stamps `src/baked-revision.ts` from `WORKERS_CI_COMMIT_SHA` (or `git rev-parse HEAD`) so the bundle contains that SHA. Do not use `wrangler deploy --var`; CLI `--var` replaces the entire `vars` map and would drop `NAI_BASE_URL`.
4. Save, then either retry a build of current `main` or push a commit. Cloudflare will deploy from that commit. Confirm the live Worker with `GET https://nai.hoshinoaya.com/health` — `revision` should match that commit SHA.

Custom domain: `nai.hoshinoaya.com` (`wrangler.jsonc` `routes`). After a successful production build, `/v1/*` responses should include `Cache-Control: private, no-store`.

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
Client (OpenAI SDK / ST / curl / MCP / ChatGPT)
        │  /v1 Bearer NAI token
        │  /mcp OAuth access token (or NAI Bearer compat)
        ▼
   Cloudflare Worker
     /v1/*  Hono OpenAI proxy
     /mcp   createMcpHandler (stateless) behind OAuth 2.1
     /authorize  consent (Persistent API token → encrypted grant props)
        │
        ├── text.novelai.net   /oa/v1/*  /ai/generate
        ├── image.novelai.net  /ai/generate-image  /ai/augment-image  /user/subscription
        ├── api.novelai.net    /ai/upscale  /ai/generate-voice
        └── R2 nai-images      orig/*.png (private)  i/*.webp (public)
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
| MCP tools / handler | `src/mcp/` |
| MCP OAuth consent | `src/oauth/` |
| Image / Director / TTS | `src/nai/` |

Chat and Responses always request `stream: true` from NovelAI. Non-stream clients get a fully aggregated `chat.completion` / `response` object. Streaming clients receive stripped OpenAI-shaped SSE (`token_ids` and other NAI-only fields removed).

## Environment

| Binding | Required | Description |
|---------|----------|-------------|
| `NAI_BASE_URL` | yes | NovelAI text API origin. Must be `https://text.novelai.net` or `https://api.novelai.net` (default: `https://text.novelai.net`) |
| `NAI_IMAGE_BASE_URL` | yes | Image API origin (also `/user/subscription` and `/user/information`). Must be `https://image.novelai.net` |
| `NAI_API_BASE_URL` | yes | Upscale / TTS origin. Must be `https://api.novelai.net` |
| `NAI_ALLOW_UNSAFE_BASE_URL` | no | Set to `1` only for local mocks; skips the host allowlist but still requires `http(s)` and rejects URLs with credentials |
| `OAUTH_KV` | yes (MCP OAuth) | Workers KV for OAuth clients, grants, short-lived consent sessions, and vibe tokens. NovelAI tokens in grants are encrypted by `workers-oauth-provider`. |
| `IMG_BUCKET` | yes (image tools) | R2 bucket `nai-images`. Original PNGs at `orig/<image_id>.png`; public WebP (or PNG fallback) at `i/<image_id>.<ext>`. |
| `IMAGES` | yes (image tools) | Cloudflare Images binding. Encodes generated PNGs to WebP quality 99 before the public put. Missing/failing falls back to a public PNG. |
| `API_RATE_LIMIT` | no | Cloudflare Rate Limiting binding (wrangler `ratelimits`); 120 requests / 60s per client IP on `/v1/*` and `/mcp` |
| `OAUTH_AUTHORIZE_RATE_LIMIT` | no | 30 requests / 60s per client IP on `GET`/`POST /authorize` |
| `OAUTH_REGISTER_RATE_LIMIT` | no | 8 requests / 60s per client IP on `POST /oauth/register` |

Authenticated `/v1/*` and `/mcp` responses set `Cache-Control: private, no-store`. Public `/i/:file` responses set `Cache-Control: public, max-age=31536000, immutable`. POST bodies are capped at 2 MiB on `/v1` and 20 MiB on `/mcp` (img2img); the MCP cap is enforced on the actual body, not only `Content-Length`. Chat/Responses payloads cap message count, prompt size, and `max_tokens`.

Callers must supply the NovelAI token per request (`Authorization: Bearer <token>`) on `/v1/*`. `/mcp` accepts either an OAuth access token issued by this Worker or a NovelAI Bearer token (compat). Tokens must be printable ASCII Bearer credentials (8–4096 chars).

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
