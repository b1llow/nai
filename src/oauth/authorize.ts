import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { parsePastedNaiToken } from "../auth";
import type { Env } from "../env";
import { HttpError, openaiError, unhandledToResponse } from "../errors";
import { MAX_AUTHORIZE_BODY_BYTES } from "../limits";
import { getSubscription } from "../nai/account";
import { enforceIpRateLimit } from "../ratelimit";
import {
  clearCookie,
  cookieNames,
  peekConsent,
  putConsent,
  readCookie,
  takeConsent,
  timingSafeEqual,
} from "./consent";
import { escapeHtml, htmlResponse } from "./html";
import { grantedScopes, naiUserId } from "./props";

export async function handleAuthorize(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  try {
    if (request.method === "GET") return await renderAuthorize(request, env);
    if (request.method === "POST") {
      await enforceIpRateLimit(env, request);
      return await submitAuthorize(request, env);
    }
    return htmlResponse(405, errorPage("Method not allowed"));
  } catch (err) {
    if (err instanceof AuthorizationError) return authorizationErrorResponse(err);
    if (err instanceof CimdFetchError) {
      return htmlResponse(400, errorPage("Could not resolve the OAuth client."));
    }
    return unhandledToResponse(err, "/authorize");
  }
}

async function renderAuthorize(request: Request, env: Env): Promise<Response> {
  const provider = requireProvider(env);
  const oauthReq = await provider.parseAuthRequest(request);
  const client = await provider.lookupClient(oauthReq.clientId);
  if (!client) {
    return htmlResponse(400, errorPage("Unknown OAuth client."));
  }

  const url = new URL(request.url);
  const names = cookieNames(url);
  const consentId = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  await putConsent(env.OAUTH_KV, consentId, { request: oauthReq, csrf });

  return htmlResponse(
    200,
    consentPage({ client, oauthReq, csrf, error: null }),
    [
      `${names.consent}=${consentId}; ${names.flags}`,
      `${names.csrf}=${csrf}; ${names.flags}`,
    ],
  );
}

async function submitAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const length = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > MAX_AUTHORIZE_BODY_BYTES) {
    throw openaiError(413, "Request body too large", {
      type: "invalid_request_error",
    });
  }

  const names = cookieNames(url);
  const cookieHeader = request.headers.get("Cookie");
  const consentId = readCookie(cookieHeader, names.consent);
  const csrfCookie = readCookie(cookieHeader, names.csrf);
  const clear = [clearCookie(names.consent, url), clearCookie(names.csrf, url)];

  if (!consentId || !csrfCookie) {
    return htmlResponse(400, errorPage("Authorization session expired. Start again from ChatGPT."), clear);
  }

  const form = await request.formData();
  const csrfForm = formString(form, "csrf_token");
  const decision = formString(form, "decision");

  if (!csrfForm || !timingSafeEqual(csrfForm, csrfCookie)) {
    await takeConsent(env.OAUTH_KV, consentId);
    return htmlResponse(400, errorPage("Invalid authorization session."), clear);
  }

  if (decision === "deny") {
    const record = await takeConsent(env.OAUTH_KV, consentId);
    if (!record || !timingSafeEqual(record.csrf, csrfCookie)) {
      return htmlResponse(400, errorPage("Invalid authorization session."), clear);
    }
    return denyRedirect(record.request, clear);
  }

  if (decision !== "approve") {
    await takeConsent(env.OAUTH_KV, consentId);
    return htmlResponse(400, errorPage("Invalid authorization session."), clear);
  }

  const record = await peekConsent(env.OAUTH_KV, consentId);
  if (!record || !timingSafeEqual(record.csrf, csrfCookie)) {
    await takeConsent(env.OAUTH_KV, consentId);
    return htmlResponse(400, errorPage("Invalid authorization session."), clear);
  }

  const provider = requireProvider(env);
  const client = await provider.lookupClient(record.request.clientId);

  let naiAuth: string;
  try {
    naiAuth = parsePastedNaiToken(formString(form, "nai_token"));
  } catch {
    return htmlResponse(
      400,
      consentPage({
        client,
        oauthReq: record.request,
        csrf: record.csrf,
        error: "Enter a NovelAI Persistent API token (at least 8 characters).",
      }),
    );
  }

  try {
    await getSubscription(env, naiAuth, request.signal);
  } catch (err) {
    const message = subscriptionErrorMessage(err);
    return htmlResponse(
      400,
      consentPage({
        client,
        oauthReq: record.request,
        csrf: record.csrf,
        error: message,
      }),
    );
  }

  const consumed = await takeConsent(env.OAUTH_KV, consentId);
  if (!consumed || !timingSafeEqual(consumed.csrf, csrfCookie)) {
    return htmlResponse(400, errorPage("Invalid authorization session."), clear);
  }

  const rawToken = naiAuth.slice("Bearer ".length);
  const { redirectTo } = await provider.completeAuthorization({
    request: consumed.request,
    userId: await naiUserId(rawToken),
    metadata: { clientName: client?.clientName ?? null },
    scope: grantedScopes(consumed.request.scope),
    props: { naiAuth },
  });

  const headers = new Headers({ Location: redirectTo });
  for (const cookie of clear) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function requireProvider(env: Env) {
  if (!env.OAUTH_PROVIDER || !env.OAUTH_KV) {
    throw openaiError(500, "Server misconfigured", {
      type: "api_error",
      code: "internal_error",
    });
  }
  return env.OAUTH_PROVIDER;
}

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function subscriptionErrorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) {
      return "That NovelAI token was rejected. Create a Persistent API token in NovelAI account settings.";
    }
    if (err.status === 429) {
      return "NovelAI rate-limited the token check. Wait a moment and try again.";
    }
  }
  return "Could not verify the NovelAI token. Try again.";
}

function authorizationErrorResponse(err: AuthorizationError): Response {
  if (!err.redirectUri) {
    return htmlResponse(400, errorPage(err.description));
  }
  const redirect = new URL(err.redirectUri);
  redirect.searchParams.set("error", err.code);
  redirect.searchParams.set("error_description", err.description);
  if (err.state) redirect.searchParams.set("state", err.state);
  if (err.issuer) redirect.searchParams.set("iss", err.issuer);
  return Response.redirect(redirect.toString(), 302);
}

function denyRedirect(oauthReq: AuthRequest, clear: string[]): Response {
  const redirect = new URL(oauthReq.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  if (oauthReq.state) redirect.searchParams.set("state", oauthReq.state);
  if (oauthReq.issuer) redirect.searchParams.set("iss", oauthReq.issuer);
  const headers = new Headers({ Location: redirect.toString() });
  for (const cookie of clear) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function consentPage(opts: {
  client: ClientInfo | null;
  oauthReq: AuthRequest;
  csrf: string;
  error: string | null;
}): string {
  const name = escapeHtml(opts.client?.clientName?.trim() || "ChatGPT");
  const scopes = escapeHtml(
    grantedScopes(opts.oauthReq.scope).join(", ") || "mcp",
  );
  const error = opts.error
    ? `<p class="error">${escapeHtml(opts.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize NovelAI MCP</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 36rem; margin: 2.5rem auto; padding: 0 1rem; line-height: 1.5; }
    .card { border: 1px solid #8884; border-radius: 12px; padding: 1.5rem; }
    h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
    label { display: block; font-weight: 600; margin: 1rem 0 0.35rem; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 0.55rem 0.7rem; border-radius: 8px; border: 1px solid #8888; }
    .hint { color: #666; font-size: 0.9rem; }
    .error { color: #b00020; background: #b0002012; padding: 0.7rem 0.85rem; border-radius: 8px; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
    button { padding: 0.55rem 1rem; border-radius: 8px; border: 0; cursor: pointer; font-size: 1rem; }
    .approve { background: #1f6feb; color: #fff; flex: 1; }
    .deny { background: #8883; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect NovelAI to ${name}</h1>
    <p>${name} is requesting access to this NovelAI MCP server.</p>
    <p class="hint">Scopes: ${scopes}. Your Persistent API token is stored encrypted with this grant and is used only to call NovelAI on your behalf. Do not send your NovelAI email or password.</p>
    ${error}
    <form method="post" action="/authorize" autocomplete="off">
      <input type="hidden" name="csrf_token" value="${escapeHtml(opts.csrf)}">
      <label for="nai_token">NovelAI Persistent API token</label>
      <input id="nai_token" name="nai_token" type="password" maxlength="4096" spellcheck="false">
      <p class="hint">Create one in NovelAI account settings. Existing OpenAI-proxy clients keep using <code>Authorization: Bearer</code> on <code>/v1</code>.</p>
      <div class="actions">
        <button class="deny" type="submit" name="decision" value="deny">Deny</button>
        <button class="approve" type="submit" name="decision" value="approve">Approve</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorization error</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 36rem; margin: 2.5rem auto; padding: 0 1rem; }
  </style>
</head>
<body>
  <h1>Authorization error</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}
