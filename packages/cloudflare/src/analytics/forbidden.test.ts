// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { APIError } from "cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflareRequest } from "../client/errors";
import { CloudflareAnalyticsManager } from "./analyticsManager";
import { STREAM_MINUTES } from "./datasets";
import { ANALYTICS_PERMISSION, type ForbiddenRefusal, guardForbidden, isAnalyticsForbidden } from "./forbidden";

/** What the GraphQL endpoint answers, as the SDK's `fetch` receives it. */
function answering(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  );
}

/** The refusal a real manager raises for the answer stubbed above. */
async function refusal(): Promise<unknown> {
  const manager = new CloudflareAnalyticsManager({ accountId: "acct-1", apiToken: "tok-1" });
  return manager.datasetLimits([STREAM_MINUTES]).catch((error: unknown) => error);
}

/** The body Cloudflare's GraphQL endpoint answers a token without the analytics grant. */
const AUTHZ = {
  data: null,
  errors: [{ message: "not authorized for that account", extensions: { code: "authz" } }],
};

/** The v4 envelope a refused credential answers under 401 or 403. */
const AUTH_ERROR = { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [] };

/** A refusal factory that records what it was handed. */
class Refused extends Error {
  constructor(
    readonly refusal: ForbiddenRefusal,
    readonly options: { cause: unknown },
  ) {
    super(refusal.message);
  }
}
const refuse = (refusal: ForbiddenRefusal, options: { cause: unknown }) => new Refused(refusal, options);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isAnalyticsForbidden", () => {
  it("reads GraphQL's authz refusal as a missing grant", async () => {
    answering(200, AUTHZ);
    const failure = await refusal();
    expect((failure as PithyError).payload.code).toBe("cloudflare/request_failed");
    expect(isAnalyticsForbidden(failure)).toBe(true);
  });

  it.each([401, 403])("reads a %i with Cloudflare's auth-class code as a missing grant", async (status) => {
    answering(status, AUTH_ERROR);
    expect(isAnalyticsForbidden(await refusal())).toBe(true);
  });

  it("reads a body-less 403 as a missing grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 403 })),
    );
    expect(isAnalyticsForbidden(await refusal())).toBe(true);
  });

  it("leaves a spent rate budget alone, because asking again is the remedy", async () => {
    answering(200, {
      data: null,
      errors: [{ message: "Rate limiter budget depleted.", extensions: { code: "budget" } }],
    });
    const failure = await refusal();
    expect((failure as PithyError).payload.code).toBe("core/upstream_failed");
    expect(isAnalyticsForbidden(failure)).toBe(false);
  });

  it("leaves a 5xx alone", async () => {
    const thrown = APIError.generate(
      503,
      { errors: [{ code: 10013, message: "Unavailable" }] },
      undefined,
      new Headers(),
    );
    const failure = await cloudflareRequest("read analytics", () => Promise.reject(thrown)).catch((error) => error);
    expect((failure as PithyError).payload.code).toBe("core/upstream_failed");
    expect(isAnalyticsForbidden(failure)).toBe(false);
  });

  it("leaves a refusal of the query itself alone", async () => {
    answering(200, { data: null, errors: [{ message: "unknown field", extensions: { code: "bad_request" } }] });
    const failure = await refusal();
    expect((failure as PithyError).payload.code).toBe("cloudflare/request_failed");
    expect(isAnalyticsForbidden(failure)).toBe(false);
  });

  it("leaves a 400 that is not auth-class alone, whatever its status", async () => {
    answering(400, { success: false, errors: [{ code: 10202, message: "Invalid argument" }], messages: [] });
    expect(isAnalyticsForbidden(await refusal())).toBe(false);
  });

  it("reads nothing that is not a Cloudflare refusal", () => {
    expect(isAnalyticsForbidden(new Error("boom"))).toBe(false);
    expect(isAnalyticsForbidden(undefined)).toBe(false);
  });
});

describe("the action line on GraphQL's authz refusal", () => {
  it("names the permission for the operator, as a refused credential's does", async () => {
    answering(200, AUTHZ);
    const failure = (await refusal()) as PithyError;
    expect(failure.payload.action).toContain(`Account → ${ANALYTICS_PERMISSION}`);
  });
});

describe("guardForbidden", () => {
  it("hands back what the read answered", async () => {
    await expect(
      guardForbidden(async () => 7, { environment: "prod", read: "the delivery read" }, refuse),
    ).resolves.toBe(7);
  });

  it("refuses a missing grant with the caller's own error, naming the permission and the rotate", async () => {
    answering(200, AUTHZ);
    const cause = await refusal();
    const failure = await guardForbidden(
      () => Promise.reject(cause),
      { environment: "staging", read: "the delivery read" },
      refuse,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Refused);
    const { refusal: refused, options } = failure as Refused;
    expect(refused.message).toBe(
      "Cloudflare refused the delivery read: this Worker's runtime token lacks Account Analytics Read. Run `pithy token rotate runtime --env staging` to re-scope it; a mint only rolls the value.",
    );
    expect(refused.params).toEqual({ permission: ANALYTICS_PERMISSION });
    expect(refused.action).toBe((cause as PithyError).payload.action);
    expect(refused.detail).toBe((cause as PithyError).payload.detail);
    expect(options.cause).toBe(cause);
  });

  it("names the rotate without an environment when the Worker names none", async () => {
    answering(403, AUTH_ERROR);
    const cause = await refusal();
    const failure = (await guardForbidden(
      () => Promise.reject(cause),
      { environment: null, read: "the delivery read" },
      refuse,
    ).catch((error: unknown) => error)) as Refused;
    expect(failure.refusal.message).toBe(
      "Cloudflare refused the delivery read: this Worker's runtime token lacks Account Analytics Read. Rotate it with `pithy token rotate` to re-scope it; a mint only rolls the value.",
    );
  });

  it("lets every other failure through unchanged", async () => {
    const other = new Error("not ours");
    await expect(
      guardForbidden(() => Promise.reject(other), { environment: "prod", read: "the delivery read" }, refuse),
    ).rejects.toBe(other);
  });
});
