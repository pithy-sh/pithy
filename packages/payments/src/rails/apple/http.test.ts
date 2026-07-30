// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PaymentsProviderUnavailableError, PaymentsRailNotConfiguredError } from "../../error/errors";
import { type AppleHttpFetch, appleJson } from "./http";

/**
 * The transport's failure mapping, which is the whole reason this module exists.
 *
 * The split that matters is between "Apple is not answering" and "Apple will never answer this". A 429 or a
 * 5xx is worth retrying and a Workflow step should fail so it is; a 401 from a wrong signing key will produce
 * the identical 401 forever, and retrying it burns a retry budget to learn nothing. Both are non-2xx and only
 * the mapping tells them apart.
 */

/** A transport that answers every request the same way. Enough for a mapping suite. */
function answering(response: { ok?: boolean; status: number; body: string }): AppleHttpFetch {
  return async () => ({
    ok: response.ok ?? response.status < 400,
    status: response.status,
    text: async () => response.body,
  });
}

describe("appleJson", () => {
  test("parses a 200 body", async () => {
    const transport = answering({ status: 200, body: JSON.stringify({ bundleId: "com.acme.app" }) });
    expect(await appleJson(transport, "https://x/subscriptions/1", { what: "the subscription statuses" })).toEqual({
      bundleId: "com.acme.app",
    });
  });

  test("passes the URL and headers through", async () => {
    const seen: { url?: string; init?: unknown } = {};
    const transport: AppleHttpFetch = async (url, init) => {
      seen.url = url;
      seen.init = init;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    await appleJson(transport, "https://x/subscriptions/1", {
      what: "the subscription statuses",
      headers: { authorization: "Bearer token" },
    });
    expect(seen.url).toBe("https://x/subscriptions/1");
    expect(seen.init).toEqual({ headers: { authorization: "Bearer token" } });
  });

  test("a 404 is an absent purchase only for a caller that said it was probing", async () => {
    const transport = answering({ status: 404, body: "{}" });
    expect(await appleJson(transport, "https://x/s/1", { what: "the statuses", absentOn404: true })).toBeUndefined();
    // Without the flag a 404 is a wrong account or a wrong host, which is a configuration statement.
    await expect(appleJson(transport, "https://x/s/1", { what: "the statuses" })).rejects.toBeInstanceOf(
      PaymentsRailNotConfiguredError,
    );
  });

  test("a 429 and a 5xx are provider_unavailable — retrying is the right response to both", async () => {
    for (const status of [429, 500, 502, 503]) {
      await expect(
        appleJson(answering({ status, body: "{}" }), "https://x/s/1", { what: "the statuses" }),
      ).rejects.toBeInstanceOf(PaymentsProviderUnavailableError);
    }
  });

  test("every other 4xx is rail_not_configured — a request we built entirely ourselves", async () => {
    for (const status of [400, 401, 403]) {
      await expect(
        appleJson(answering({ status, body: "{}" }), "https://x/s/1", { what: "the statuses" }),
      ).rejects.toBeInstanceOf(PaymentsRailNotConfiguredError);
    }
  });

  test("a 401 names the credential an operator has to fix", async () => {
    const caught = await appleJson(answering({ status: 401, body: "{}" }), "https://x/s/1", {
      what: "the statuses",
    }).catch((error: unknown) => error);
    expect((caught as PaymentsRailNotConfiguredError).payload.detail).toContain("issuer id");
  });

  test("a transport that throws is provider_unavailable, not a crash", async () => {
    const transport: AppleHttpFetch = async () => {
      throw new TypeError("network");
    };
    await expect(appleJson(transport, "https://x/s/1", { what: "the statuses" })).rejects.toBeInstanceOf(
      PaymentsProviderUnavailableError,
    );
  });

  test("a non-JSON 200 is provider_unavailable, never an absent purchase", async () => {
    // The realistic shape is an HTML error page from a proxy. Reading that as "no such subscription" would
    // leave a live subscription looking unreconciled forever.
    await expect(
      appleJson(answering({ status: 200, body: "<html>gateway</html>" }), "https://x/s/1", { what: "the statuses" }),
    ).rejects.toBeInstanceOf(PaymentsProviderUnavailableError);
  });

  test("no refusal quotes the URL or the body — both carry a transaction id", async () => {
    const caught = await appleJson(answering({ status: 500, body: "2000000731004811 not found" }), "https://x/s/xyz", {
      what: "the statuses",
    }).catch((error: unknown) => error);
    const detail = (caught as PaymentsProviderUnavailableError).payload.detail ?? "";
    expect(detail).not.toContain("xyz");
    expect(detail).not.toContain("2000000731004811");
  });
});
