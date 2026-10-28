// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { AuthFetch, AuthRequestInit } from "./api";
import { decideConsent, listConnectedApplications, readConsent, revokeConnectedApplication } from "./mcp";

/** A fetch that records each call and answers one body. */
function recorder(body: unknown, status = 200) {
  const calls: { url: string; init: AuthRequestInit | undefined }[] = [];
  const fetch: AuthFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetch, calls };
}

const view = {
  client: { id: "c1", reportedName: "X", reportedUri: null, redirectUri: "http://127.0.0.1:1/cb" },
  capabilities: [],
  requested: [],
};

describe("the MCP screens' client", () => {
  test("reads the consent view from the MCP base path, carrying the screen's query", async () => {
    const { fetch, calls } = recorder(view);
    const result = await readConsent("?client_id=c1&sig=s", { fetch });
    expect(result).toEqual({ ok: true, value: view });
    expect(calls[0]?.url).toBe("/mcp/consent?oauth_query=client_id%3Dc1%26sig%3Ds");
    expect(calls[0]?.init?.credentials).toBe("include");
  });

  test("sends one decision, and answers where the browser goes", async () => {
    const { fetch, calls } = recorder({ redirect: "http://127.0.0.1:1/cb?code=x" });
    const result = await decideConsent("client_id=c1", true, { fetch });
    expect(result).toEqual({ ok: true, value: { redirect: "http://127.0.0.1:1/cb?code=x" } });
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ oauth_query: "client_id=c1", accept: true });
  });

  test("lists connected applications, and revokes one by an encoded id", async () => {
    const listed = recorder({
      applications: [{ clientId: "c1", reportedName: null, redirectUris: [], approvedAt: "t" }],
    });
    expect(await listConnectedApplications({ fetch: listed.fetch })).toEqual({
      ok: true,
      value: [{ clientId: "c1", reportedName: null, redirectUris: [], approvedAt: "t" }],
    });
    const revoked = recorder({ revoked: true });
    await revokeConnectedApplication("a/b", { fetch: revoked.fetch });
    expect(revoked.calls[0]?.url).toBe("/mcp/connections/a%2Fb");
    expect(revoked.calls[0]?.init?.method).toBe("DELETE");
  });

  test("a refusal arrives as the server's failure, and an unexpected body as unreadable", async () => {
    const refused = recorder({ error: { code: "validation/invalid_input", message: "Expired." } }, 400);
    expect(await readConsent("q", { fetch: refused.fetch })).toEqual({
      ok: false,
      failure: { code: "validation/invalid_input", message: "Expired.", action: null },
    });
    const odd = recorder({ nope: true });
    expect((await readConsent("q", { fetch: odd.fetch })).ok).toBe(false);
  });
});
