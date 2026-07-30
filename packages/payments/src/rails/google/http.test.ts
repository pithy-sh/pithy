// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PaymentsProviderUnavailableError } from "../../error/errors";
import { type GoogleHttpFetch, googleJson } from "./http";

/**
 * The transport's failure mapping, which is the whole reason this module exists. Google answers a purchase
 * lookup in four materially different ways — the state, "no such purchase", "you may not ask", and nothing at
 * all — and only the second is a fact about the purchase. Collapsing the other three into a silent skip is how
 * a renewal disappears.
 */

/** A transport that answers every request the same way. Enough for a mapping suite. */
function answering(response: { ok?: boolean; status: number; body: string }): GoogleHttpFetch {
  return async () => ({
    ok: response.ok ?? response.status < 400,
    status: response.status,
    text: async () => response.body,
  });
}

describe("googleJson", () => {
  test("parses a 200 body", async () => {
    const transport = answering({ status: 200, body: JSON.stringify({ subscriptionState: "ACTIVE" }) });
    expect(await googleJson(transport, "https://x/purchase", { what: "the purchase" })).toEqual({
      subscriptionState: "ACTIVE",
    });
  });

  test("passes the method, headers, and body through", async () => {
    const seen: { url?: string; init?: unknown } = {};
    const transport: GoogleHttpFetch = async (url, init) => {
      seen.url = url;
      seen.init = init;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    await googleJson(transport, "https://x/token", {
      what: "an access token",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=x",
    });
    expect(seen.url).toBe("https://x/token");
    expect(seen.init).toEqual({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=x",
    });
  });

  test("a 404 is undefined when the caller says absence is an answer", async () => {
    // Play has no "what kind of purchase is this token" call, so a 404 from the subscription endpoint is how a
    // one-time purchase identifies itself. That is a fact, not a failure.
    const transport = answering({ status: 404, body: "{}" });
    expect(await googleJson(transport, "https://x", { what: "the subscription", absentOn404: true })).toBeUndefined();
  });

  test("a 404 is a failure when the caller did not", async () => {
    const transport = answering({ status: 404, body: "{}" });
    await expect(googleJson(transport, "https://x", { what: "the purchase" })).rejects.toBeInstanceOf(
      PaymentsProviderUnavailableError,
    );
  });

  test("a 503 is payments/provider_unavailable, never a silent skip", async () => {
    const thrown = await catchError(() =>
      googleJson(answering({ status: 503, body: "upstream" }), "https://x", { what: "the purchase" }),
    );
    expect(thrown?.payload.code).toBe("payments/provider_unavailable");
    expect(thrown?.payload.status).toBe(503);
    expect(thrown?.payload.detail).toContain("503");
  });

  test("a 401 says which permission is likely missing, to the operator only", async () => {
    // The most common Play setup failure by a distance: the service account exists but was never granted
    // financial-data access in the Play Console. That belongs in `detail`, which the HTTP codec strips.
    const thrown = await catchError(() =>
      googleJson(answering({ status: 401, body: "unauthorized" }), "https://x", { what: "the purchase" }),
    );
    expect(thrown?.payload.detail).toContain("Play Console");
    expect(thrown?.payload.message).not.toContain("Play Console");
  });

  test("a 429 is provider_unavailable too — a rate limit is a retry, not a refusal", async () => {
    const thrown = await catchError(() =>
      googleJson(answering({ status: 429, body: "slow down" }), "https://x", { what: "the purchase" }),
    );
    expect(thrown?.payload.code).toBe("payments/provider_unavailable");
  });

  test("a transport that throws is provider_unavailable, with the cause kept", async () => {
    const boom = new Error("connect ETIMEDOUT");
    const thrown = await catchError(() =>
      googleJson(
        () => {
          throw boom;
        },
        "https://x",
        { what: "the purchase" },
      ),
    );
    expect(thrown?.payload.code).toBe("payments/provider_unavailable");
    expect(thrown?.cause).toBe(boom);
  });

  test("a 200 that is not JSON is provider_unavailable, not an empty state", async () => {
    // An HTML error page behind a proxy is the realistic shape of this. Treating it as an absent purchase would
    // revoke somebody's subscription.
    const thrown = await catchError(() =>
      googleJson(answering({ status: 200, body: "<html>proxy</html>" }), "https://x", { what: "the purchase" }),
    );
    expect(thrown?.payload.code).toBe("payments/provider_unavailable");
    expect(thrown?.payload.detail).toContain("non-JSON");
  });

  test("no refusal carries the response body", async () => {
    // Google's error bodies quote the request, and a Play request URL contains the purchase token.
    const thrown = await catchError(() =>
      googleJson(answering({ status: 400, body: "token=SECRETTOKEN is invalid" }), "https://x", {
        what: "the purchase",
      }),
    );
    expect(JSON.stringify(thrown?.payload)).not.toContain("SECRETTOKEN");
  });

  test("no refusal carries the URL, which holds the purchase token", async () => {
    const thrown = await catchError(() =>
      googleJson(answering({ status: 500, body: "boom" }), "https://x/tokens/SECRETTOKEN", { what: "the purchase" }),
    );
    expect(JSON.stringify(thrown?.payload)).not.toContain("SECRETTOKEN");
  });
});

/** The thrown `PithyError`, or undefined. */
async function catchError(run: () => Promise<unknown>): Promise<PaymentsProviderUnavailableError | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error as PaymentsProviderUnavailableError;
  }
}
