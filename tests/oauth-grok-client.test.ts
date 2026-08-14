import { describe, expect, it } from "vitest";
import {
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_CLIENT_NAME,
  GROK_OAUTH_REDIRECT_URIS,
  ensurePersistentGrokClient,
} from "../src/oauth/grok-client";
import { memoryKv } from "./helpers";

const CLIENT_KEY = `client:${GROK_OAUTH_CLIENT_ID}`;

describe("ensurePersistentGrokClient", () => {
  it("stores a public Grok client without a KV TTL", async () => {
    const kv = memoryKv();
    const put = kv.put.bind(kv);
    const calls: Array<{ key: string; opts: unknown }> = [];
    kv.put = async (key, value, opts) => {
      calls.push({ key, opts });
      return put(key, value, opts);
    };

    await ensurePersistentGrokClient(kv);

    expect(calls).toEqual([{ key: CLIENT_KEY, opts: undefined }]);
    const stored = (await kv.get(CLIENT_KEY, { type: "json" })) as {
      clientId?: string;
      clientName?: string;
      tokenEndpointAuthMethod?: string;
      redirectUris?: string[];
      grantTypes?: string[];
    };
    expect(stored.clientId).toBe(GROK_OAUTH_CLIENT_ID);
    expect(stored.clientName).toBe(GROK_OAUTH_CLIENT_NAME);
    expect(stored.tokenEndpointAuthMethod).toBe("none");
    expect(stored.redirectUris).toEqual([...GROK_OAUTH_REDIRECT_URIS]);
    expect(stored.grantTypes).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });

  it("does not rewrite a canonical record", async () => {
    const kv = memoryKv();
    await ensurePersistentGrokClient(kv);
    const put = kv.put.bind(kv);
    let puts = 0;
    kv.put = async (key, value, opts) => {
      puts += 1;
      return put(key, value, opts);
    };
    await ensurePersistentGrokClient(kv);
    expect(puts).toBe(0);
  });

  it("rewrites a DCR-shaped record so it no longer expires", async () => {
    const kv = memoryKv();
    await kv.put(
      CLIENT_KEY,
      JSON.stringify({
        clientId: GROK_OAUTH_CLIENT_ID,
        redirectUris: ["https://grok.com/connectors-oauth-exchange-code/"],
        clientName: "grok-connector",
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        registrationDate: 1,
        tokenEndpointAuthMethod: "none",
      }),
      { expirationTtl: 90 * 24 * 60 * 60 },
    );

    const put = kv.put.bind(kv);
    const calls: Array<{ opts: unknown }> = [];
    kv.put = async (key, value, opts) => {
      calls.push({ opts });
      return put(key, value, opts);
    };

    await ensurePersistentGrokClient(kv);

    expect(calls).toEqual([{ opts: undefined }]);
    const stored = (await kv.get(CLIENT_KEY, { type: "json" })) as {
      registrationDate?: number;
      redirectUris?: string[];
    };
    expect(stored.registrationDate).toBe(1);
    expect(stored.redirectUris).toEqual([...GROK_OAUTH_REDIRECT_URIS]);
  });
});
