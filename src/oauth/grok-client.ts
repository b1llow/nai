/**
 * Grok's Custom Connector form needs a pre-issued public client_id and never
 * runs DCR. `OAuthHelpers.createClient()` stores clients without
 * `clientRegistrationTTL`, but always mints a random id. Write the same KV
 * record (`client:<id>`, no expiration) under a stable id so README can
 * document it and connectors do not break after the 90-day DCR default.
 */
export const GROK_OAUTH_CLIENT_ID = "grok-connector";
export const GROK_OAUTH_CLIENT_NAME = "Grok";
export const GROK_OAUTH_REDIRECT_URIS = [
  "https://grok.com/connectors-oauth-exchange-code/",
  "https://grok.com/connectors-oauth-exchange-code",
  "https://www.grok.com/connectors-oauth-exchange-code/",
  "https://www.grok.com/connectors-oauth-exchange-code",
] as const;

const CLIENT_KEY = `client:${GROK_OAUTH_CLIENT_ID}`;

type StoredClient = {
  clientId: string;
  redirectUris: string[];
  clientName: string;
  grantTypes: string[];
  responseTypes: string[];
  registrationDate: number;
  tokenEndpointAuthMethod: "none";
  authMethodExplicit: true;
};

export async function ensurePersistentGrokClient(
  kv: KVNamespace,
): Promise<void> {
  const existing = await kv.get(CLIENT_KEY, { type: "json" });
  if (isCanonicalPersistentGrokClient(existing)) return;

  const registrationDate =
    existing &&
    typeof existing === "object" &&
    Number.isInteger((existing as { registrationDate?: unknown }).registrationDate)
      ? ((existing as { registrationDate: number }).registrationDate)
      : Math.floor(Date.now() / 1000);

  const record: StoredClient = {
    clientId: GROK_OAUTH_CLIENT_ID,
    redirectUris: [...GROK_OAUTH_REDIRECT_URIS],
    clientName: GROK_OAUTH_CLIENT_NAME,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    registrationDate,
    tokenEndpointAuthMethod: "none",
    authMethodExplicit: true,
  };
  await kv.put(CLIENT_KEY, JSON.stringify(record));
}

function isCanonicalPersistentGrokClient(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const client = raw as {
    clientId?: unknown;
    redirectUris?: unknown;
    clientName?: unknown;
    grantTypes?: unknown;
    responseTypes?: unknown;
    tokenEndpointAuthMethod?: unknown;
  };
  return (
    client.clientId === GROK_OAUTH_CLIENT_ID &&
    client.clientName === GROK_OAUTH_CLIENT_NAME &&
    client.tokenEndpointAuthMethod === "none" &&
    sameStrings(stringArray(client.redirectUris), GROK_OAUTH_REDIRECT_URIS) &&
    includesAll(stringArray(client.grantTypes), [
      "authorization_code",
      "refresh_token",
    ]) &&
    includesAll(stringArray(client.responseTypes), ["code"])
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function sameStrings(left: string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, i) => value === b[i]);
}

function includesAll(haystack: string[], needles: readonly string[]): boolean {
  return needles.every((needle) => haystack.includes(needle));
}
