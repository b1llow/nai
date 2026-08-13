import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { parsePastedNaiToken } from "../auth";
import { limitRequestBody } from "../body-limit";
import type { Env } from "../env";
import { HttpError, openaiError, unhandledToResponse } from "../errors";
import { MAX_AUTHORIZE_BODY_BYTES } from "../limits";
import { getSubscription } from "../nai/account";
import { enforceIpRateLimit } from "../ratelimit";
import {
  isConsentId,
  isSameOriginRequest,
  putConsent,
  takeConsent,
  timingSafeEqual,
} from "./consent";
import { escapeHtml, htmlResponse } from "./html";
import { grantedScopes, naiUserId } from "./props";
import { isAllowedOAuthRedirect } from "./redirects";

export async function handleAuthorize(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  try {
    if (request.method !== "GET" && request.method !== "POST") {
      return htmlResponse(405, errorPage("Method not allowed"));
    }
    await enforceIpRateLimit(env, request, env.OAUTH_AUTHORIZE_RATE_LIMIT);
    if (request.method === "GET") return await renderAuthorize(request, env);
    return await submitAuthorize(request, env);
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
  if (!isAllowedOAuthRedirect(oauthReq.redirectUri)) {
    return htmlResponse(400, errorPage(disallowedRedirectMessage));
  }

  const consentId = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  await putConsent(env.OAUTH_KV, consentId, { request: oauthReq, csrf });

  return htmlResponse(
    200,
    consentPage({ client, oauthReq, consentId, csrf, error: null }),
  );
}

async function submitAuthorize(request: Request, env: Env): Promise<Response> {
  const inbound = await limitRequestBody(request, MAX_AUTHORIZE_BODY_BYTES);
  const provider = requireProvider(env);

  if (!isSameOriginRequest(inbound)) {
    return htmlResponse(400, errorPage("Invalid authorization session."));
  }

  const form = await inbound.formData();
  const consentId = formString(form, "consent_id");
  const csrfForm = formString(form, "csrf_token");
  const decision = formString(form, "decision");

  if (!isConsentId(consentId) || !csrfForm) {
    return htmlResponse(
      400,
      errorPage("Authorization session expired. Start again from your MCP client."),
    );
  }

  if (decision === "deny") {
    const record = await takeConsent(env.OAUTH_KV, consentId);
    if (!record || !timingSafeEqual(record.csrf, csrfForm)) {
      return htmlResponse(400, errorPage("Invalid authorization session."));
    }
    return denyRedirect(record.request);
  }

  if (decision !== "approve") {
    await takeConsent(env.OAUTH_KV, consentId);
    return htmlResponse(400, errorPage("Invalid authorization session."));
  }

  const record = await takeConsent(env.OAUTH_KV, consentId);
  if (!record || !timingSafeEqual(record.csrf, csrfForm)) {
    return htmlResponse(400, errorPage("Invalid authorization session."));
  }
  if (!isAllowedOAuthRedirect(record.request.redirectUri)) {
    return htmlResponse(400, errorPage(disallowedRedirectMessage));
  }

  let client: ClientInfo | null;
  try {
    client = await provider.lookupClient(record.request.clientId);
  } catch (err) {
    await putConsent(env.OAUTH_KV, consentId, record);
    throw err;
  }

  let naiAuth: string;
  try {
    naiAuth = parsePastedNaiToken(formString(form, "nai_token"));
  } catch {
    await putConsent(env.OAUTH_KV, consentId, record);
    return htmlResponse(
      400,
      consentPage({
        client,
        oauthReq: record.request,
        consentId,
        csrf: record.csrf,
        error: "Enter a NovelAI Persistent API token (at least 8 characters).",
      }),
    );
  }

  try {
    await getSubscription(env, naiAuth, inbound.signal);
  } catch (err) {
    await putConsent(env.OAUTH_KV, consentId, record);
    const message = subscriptionErrorMessage(err);
    return htmlResponse(
      400,
      consentPage({
        client,
        oauthReq: record.request,
        consentId,
        csrf: record.csrf,
        error: message,
      }),
    );
  }

  const rawToken = naiAuth.slice("Bearer ".length);
  let redirectTo: string;
  try {
    ({ redirectTo } = await provider.completeAuthorization({
      request: record.request,
      userId: await naiUserId(rawToken),
      metadata: { clientName: client?.clientName ?? null },
      scope: grantedScopes(record.request.scope),
      props: { naiAuth },
    }));
  } catch (err) {
    await putConsent(env.OAUTH_KV, consentId, record);
    throw err;
  }

  if (!isAllowedOAuthRedirect(redirectTo)) {
    return htmlResponse(400, errorPage(disallowedRedirectMessage));
  }

  return new Response(null, {
    status: 302,
    headers: { Location: redirectTo },
  });
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

const disallowedRedirectMessage =
  "This redirect URI is not allowed for this server.";

function authorizationErrorResponse(err: AuthorizationError): Response {
  if (!err.redirectUri || !isAllowedOAuthRedirect(err.redirectUri)) {
    return htmlResponse(400, errorPage(err.description));
  }
  const redirect = new URL(err.redirectUri);
  redirect.searchParams.set("error", err.code);
  redirect.searchParams.set("error_description", err.description);
  if (err.state) redirect.searchParams.set("state", err.state);
  if (err.issuer) redirect.searchParams.set("iss", err.issuer);
  return Response.redirect(redirect.toString(), 302);
}

function denyRedirect(oauthReq: AuthRequest): Response {
  if (!isAllowedOAuthRedirect(oauthReq.redirectUri)) {
    return htmlResponse(400, errorPage(disallowedRedirectMessage));
  }
  const redirect = new URL(oauthReq.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  if (oauthReq.state) redirect.searchParams.set("state", oauthReq.state);
  if (oauthReq.issuer) redirect.searchParams.set("iss", oauthReq.issuer);
  return new Response(null, {
    status: 302,
    headers: { Location: redirect.toString() },
  });
}

function consentPage(opts: {
  client: ClientInfo | null;
  oauthReq: AuthRequest;
  consentId: string;
  csrf: string;
  error: string | null;
}): string {
  const rawName = opts.client?.clientName?.trim();
  const name = escapeHtml(rawName || "an MCP client");
  const clientId = escapeHtml(opts.oauthReq.clientId);
  const redirectUri = escapeHtml(opts.oauthReq.redirectUri);
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
    .meta { margin: 0.85rem 0; padding: 0.7rem 0.85rem; background: #8882; border-radius: 8px; font-size: 0.85rem; }
    .meta dt { font-weight: 600; margin-top: 0.45rem; }
    .meta dt:first-child { margin-top: 0; }
    .meta dd { margin: 0.15rem 0 0; overflow-wrap: anywhere; }
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
    <dl class="meta">
      <dt>Client ID</dt>
      <dd><code>${clientId}</code></dd>
      <dt>Redirect URI</dt>
      <dd><code>${redirectUri}</code></dd>
    </dl>
    <p class="hint">Confirm this is the client and callback you expect before pasting a token. Scopes: ${scopes}. Your Persistent API token is stored encrypted with this grant and is used only to call NovelAI on your behalf. Do not send your NovelAI email or password.</p>
    ${error}
    <form method="post" action="/authorize" autocomplete="off">
      <input type="hidden" name="consent_id" value="${escapeHtml(opts.consentId)}">
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
