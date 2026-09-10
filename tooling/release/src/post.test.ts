// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import type { MintToken } from "./oidc";
import { postReleaseRecords, type ReleaseDestination, releaseRecordsConfig } from "./post";
import type { ReleaseRecord } from "./records";

const RECORD: ReleaseRecord = {
  package: "@pithy-sh/auth",
  version: "1.4.2",
  major: 1,
  minor: 4,
  patch: 2,
  prerelease: null,
  bump: "patch",
  published: "2026-08-14T09:12:00.000Z",
  note: "Refresh-token reuse now revokes the whole family.",
  security: true,
  exposure: "A revoked refresh token stayed valid until its natural expiry.",
};

const STAGING: ReleaseDestination = {
  name: "staging",
  url: "https://staging.dashboard.pithy.sh/api/releases",
  audience: "https://staging.dashboard.pithy.sh",
};

const PROD: ReleaseDestination = {
  name: "prod",
  url: "https://dashboard.pithy.sh/api/releases",
  audience: "https://dashboard.pithy.sh",
};

const URLS = {
  PITHY_RELEASE_RECORDS_URL_STAGING: STAGING.url,
  PITHY_RELEASE_RECORDS_URL_PROD: PROD.url,
};

function ok(): typeof fetch {
  return vi.fn(async () => new Response("{}", { status: 202 })) as unknown as typeof fetch;
}

/** A minter that names the audience it was asked for, so a request can be traced back to one. */
function minter(): MintToken {
  return vi.fn(async (audience: string) => `token-for-${audience}`);
}

function calls(send: typeof fetch): [string, RequestInit][] {
  return (send as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
}

describe("releaseRecordsConfig", () => {
  // The dashboard's endpoints are not set. This is the state the pipeline ships in, and it is off
  // because the configuration is absent, not because a second switch says so. One fact, one place.
  it("is off when nothing is configured", () => {
    expect(releaseRecordsConfig({})).toEqual([]);
  });

  it("is off when a variable is set to the empty string", () => {
    expect(releaseRecordsConfig({ PITHY_RELEASE_RECORDS_URL_STAGING: "", PITHY_RELEASE_RECORDS_URL_PROD: "" })).toEqual(
      [],
    );
  });

  // Both destinations, from two variables and no secret between them — the whole of part 3.
  it("builds a destination for each configured endpoint", () => {
    expect(releaseRecordsConfig(URLS)).toEqual([STAGING, PROD]);
  });

  it("takes one destination without the other", () => {
    expect(releaseRecordsConfig({ PITHY_RELEASE_RECORDS_URL_PROD: PROD.url })).toEqual([PROD]);
  });

  // The property the per-destination audience buys: a token minted for staging names staging, so it is
  // not replayable against production. A shared audience would make the two interchangeable.
  it("gives each destination its own audience, from its own origin", () => {
    const [staging, prod] = releaseRecordsConfig(URLS);

    expect(staging?.audience).toBe("https://staging.dashboard.pithy.sh");
    expect(prod?.audience).toBe("https://dashboard.pithy.sh");
    expect(staging?.audience).not.toBe(prod?.audience);
  });

  // A bearer credential does not go over a cleartext hop, and a release job is not the place to
  // discover that it did.
  it("refuses an endpoint that is not https", () => {
    expect(() => releaseRecordsConfig({ PITHY_RELEASE_RECORDS_URL_PROD: "http://dashboard.pithy.sh/api" })).toThrow(
      /https/i,
    );
  });

  it("refuses an endpoint that is not a URL", () => {
    expect(() => releaseRecordsConfig({ PITHY_RELEASE_RECORDS_URL_STAGING: "dashboard.pithy.sh" })).toThrow(/url/i);
  });

  it("names the variable that is wrong", () => {
    expect(() => releaseRecordsConfig({ PITHY_RELEASE_RECORDS_URL_STAGING: "nope" })).toThrow(
      /PITHY_RELEASE_RECORDS_URL_STAGING/,
    );
  });
});

describe("postReleaseRecords", () => {
  it("does not post when no destination is configured", async () => {
    const send = ok();

    const outcome = await postReleaseRecords({ records: [RECORD], destinations: [], mintToken: minter(), fetch: send });

    expect(outcome).toEqual({ status: "off" });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not post when there is nothing to report", async () => {
    const send = ok();

    const outcome = await postReleaseRecords({
      records: [],
      destinations: [STAGING],
      mintToken: minter(),
      fetch: send,
    });

    expect(outcome).toEqual({ status: "empty" });
    expect(send).not.toHaveBeenCalled();
  });

  // The dry run's proof delivery: a real token and a real answer, and no rows.
  it("posts a zero-record delivery when asked to", async () => {
    const send = ok();

    const outcome = await postReleaseRecords({
      records: [],
      destinations: [STAGING],
      mintToken: minter(),
      fetch: send,
      sendEmpty: true,
    });

    expect(outcome).toEqual({
      status: "delivered",
      deliveries: [{ destination: "staging", status: "posted", count: 0 }],
    });
    expect(JSON.parse(calls(send)[0]?.[1].body as string)).toEqual({ records: [] });
  });

  it("posts the records to every destination", async () => {
    const send = ok();

    const outcome = await postReleaseRecords({
      records: [RECORD],
      destinations: [STAGING, PROD],
      mintToken: minter(),
      fetch: send,
    });

    expect(outcome).toEqual({
      status: "delivered",
      deliveries: [
        { destination: "staging", status: "posted", count: 1 },
        { destination: "prod", status: "posted", count: 1 },
      ],
    });
    expect(
      calls(send)
        .map(([url]) => url)
        .sort(),
    ).toEqual([PROD.url, STAGING.url].sort());
    for (const [, init] of calls(send)) {
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(init.body as string)).toEqual({ records: [RECORD] });
    }
  });

  // One token per destination, each naming that destination's audience. A single shared token would be
  // replayable from one dashboard against the other, which is the property this whole scheme is for.
  it("sends each destination a token minted for its own audience", async () => {
    const send = ok();
    const mintToken = minter();

    await postReleaseRecords({ records: [RECORD], destinations: [STAGING, PROD], mintToken, fetch: send });

    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(mintToken).toHaveBeenCalledWith(STAGING.audience);
    expect(mintToken).toHaveBeenCalledWith(PROD.audience);
    const sent = new Map(
      calls(send).map(([url, init]) => [url, new Headers(init.headers).get("authorization")] as const),
    );
    expect(sent.get(STAGING.url)).toBe(`Bearer token-for-${STAGING.audience}`);
    expect(sent.get(PROD.url)).toBe(`Bearer token-for-${PROD.audience}`);
  });

  // A staging outage cannot cost the production record. That is the reason there are two destinations
  // rather than one with a fallback.
  it("posts to one destination when the other fails", async () => {
    const send = vi.fn(async (url: string) =>
      url === STAGING.url ? Promise.reject(new Error("ECONNREFUSED")) : new Response("{}", { status: 202 }),
    ) as unknown as typeof fetch;

    const outcome = await postReleaseRecords({
      records: [RECORD],
      destinations: [STAGING, PROD],
      mintToken: minter(),
      fetch: send,
    });

    expect(outcome).toEqual({
      status: "delivered",
      deliveries: [
        { destination: "staging", status: "failed", reason: "ECONNREFUSED" },
        { destination: "prod", status: "posted", count: 1 },
      ],
    });
  });

  // A token that cannot be minted is one destination's problem, not the other's.
  it("fails only the destination whose token could not be minted", async () => {
    const send = ok();
    const mintToken: MintToken = async (audience: string) => {
      if (audience === PROD.audience) throw new Error("no OIDC token endpoint");
      return `token-for-${audience}`;
    };

    const outcome = await postReleaseRecords({
      records: [RECORD],
      destinations: [STAGING, PROD],
      mintToken,
      fetch: send,
    });

    expect(outcome.status === "delivered" && outcome.deliveries).toEqual([
      { destination: "staging", status: "posted", count: 1 },
      { destination: "prod", status: "failed", reason: "no OIDC token endpoint" },
    ]);
    expect(calls(send)).toHaveLength(1);
  });

  // The record is the contract with `pithy-sh/dashboard#2`. Sending a malformed one is worse than
  // sending none: the dashboard would store a release nobody can compare against.
  it("refuses to post a record that does not satisfy the contract", async () => {
    const send = ok();
    const broken = { ...RECORD, patch: 3 } as ReleaseRecord;

    const outcome = await postReleaseRecords({
      records: [broken],
      destinations: [STAGING, PROD],
      mintToken: minter(),
      fetch: send,
    });

    expect(outcome.status === "delivered" && outcome.deliveries.every((d) => d.status === "failed")).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  // An unreachable dashboard cannot block publishing an open-source package. Every one of these reports
  // the failure and returns — nothing throws, and `replay` recovers the gap.
  it("reports a rejection without throwing", async () => {
    const send = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const outcome = await postReleaseRecords({
      records: [RECORD],
      destinations: [PROD],
      mintToken: minter(),
      fetch: send,
    });

    expect(outcome.status === "delivered" && outcome.deliveries[0]?.status).toBe("failed");
    expect(JSON.stringify(outcome)).toMatch(/500/);
  });

  it("gives up on a dashboard that never answers", async () => {
    const send = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;

    const outcome = await postReleaseRecords({
      records: [RECORD],
      destinations: [PROD],
      mintToken: minter(),
      fetch: send,
      timeoutMs: 5,
    });

    expect(outcome.status === "delivered" && outcome.deliveries[0]?.status).toBe("failed");
  });

  // The token reaches one place: the Authorization header. A failure line goes to a public CI log.
  it("never puts the credential in what it reports", async () => {
    const send = vi.fn(async () => {
      throw new Error(`failed to reach the dashboard with token-for-${PROD.audience}`);
    }) as unknown as typeof fetch;

    const outcome = await postReleaseRecords({
      records: [RECORD],
      destinations: [PROD],
      mintToken: minter(),
      fetch: send,
    });

    expect(JSON.stringify(outcome)).not.toContain(`token-for-${PROD.audience}`);
  });

  it("never puts the credential in a rejection body it echoes", async () => {
    const send = vi.fn(
      async () => new Response(`rejected token-for-${PROD.audience}`, { status: 403 }),
    ) as unknown as typeof fetch;

    const outcome = await postReleaseRecords({
      records: [RECORD],
      destinations: [PROD],
      mintToken: minter(),
      fetch: send,
    });

    expect(JSON.stringify(outcome)).not.toContain(`token-for-${PROD.audience}`);
  });
});
