// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import { postReleaseRecords, releaseRecordsConfig } from "./post";
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

const CONFIGURED = { url: "https://dashboard.pithy.sh/api/releases", token: "secret-token" };

function ok(): typeof fetch {
  return vi.fn(async () => new Response("{}", { status: 202 })) as unknown as typeof fetch;
}

describe("releaseRecordsConfig", () => {
  // The dashboard does not exist yet. Nothing is set, so the step is off — and it is off because the
  // configuration is absent, not because a second switch says so. One fact, one place.
  it("is off when nothing is configured", () => {
    expect(releaseRecordsConfig({})).toEqual({ configured: false, reason: "no endpoint configured" });
  });

  it("is off when the endpoint is set but the credential is not", () => {
    expect(releaseRecordsConfig({ PITHY_RELEASE_RECORDS_URL: CONFIGURED.url })).toMatchObject({ configured: false });
  });

  it("is off when the credential is set but the endpoint is not", () => {
    expect(releaseRecordsConfig({ PITHY_RELEASE_RECORDS_TOKEN: "t" })).toMatchObject({ configured: false });
  });

  it("is off when a variable is set to the empty string", () => {
    expect(releaseRecordsConfig({ PITHY_RELEASE_RECORDS_URL: "", PITHY_RELEASE_RECORDS_TOKEN: "" })).toMatchObject({
      configured: false,
    });
  });

  it("is on when both are set", () => {
    expect(
      releaseRecordsConfig({ PITHY_RELEASE_RECORDS_URL: CONFIGURED.url, PITHY_RELEASE_RECORDS_TOKEN: "t" }),
    ).toEqual({ configured: true, url: CONFIGURED.url, token: "t" });
  });

  // A bearer credential does not go over a cleartext hop, and a release job is not the place to
  // discover that it did.
  it("refuses an endpoint that is not https", () => {
    expect(() =>
      releaseRecordsConfig({
        PITHY_RELEASE_RECORDS_URL: "http://dashboard.pithy.sh/api",
        PITHY_RELEASE_RECORDS_TOKEN: "t",
      }),
    ).toThrow(/https/i);
  });

  it("refuses an endpoint that is not a URL", () => {
    expect(() =>
      releaseRecordsConfig({ PITHY_RELEASE_RECORDS_URL: "dashboard.pithy.sh", PITHY_RELEASE_RECORDS_TOKEN: "t" }),
    ).toThrow(/url/i);
  });
});

describe("postReleaseRecords", () => {
  it("does not post when the endpoint is not configured", async () => {
    const send = ok();

    const outcome = await postReleaseRecords({
      records: [RECORD],
      config: { configured: false, reason: "off" },
      fetch: send,
    });

    expect(outcome.status).toBe("off");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not post when there is nothing to report", async () => {
    const send = ok();

    const outcome = await postReleaseRecords({ records: [], config: { ...CONFIGURED, configured: true }, fetch: send });

    expect(outcome.status).toBe("empty");
    expect(send).not.toHaveBeenCalled();
  });

  it("posts the records to the endpoint under the credential", async () => {
    const send = ok();

    const outcome = await postReleaseRecords({
      records: [RECORD],
      config: { ...CONFIGURED, configured: true },
      fetch: send,
    });

    expect(outcome).toEqual({ status: "posted", count: 1 });
    const [url, init] = (send as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CONFIGURED.url);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-token");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ records: [RECORD] });
  });

  // The record is the contract with `pithy-sh/dashboard#2`. Sending a malformed one is worse than
  // sending none: the dashboard would store a release nobody can compare against.
  it("refuses to post a record that does not satisfy the contract", async () => {
    const send = ok();
    const broken = { ...RECORD, patch: 3 } as ReleaseRecord;

    const outcome = await postReleaseRecords({
      records: [broken],
      config: { ...CONFIGURED, configured: true },
      fetch: send,
    });

    expect(outcome.status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });

  // An unreachable dashboard cannot block publishing an open-source package. Every one of these
  // reports the failure and returns — the caller exits 0 and the replay script recovers the gap.
  it("reports a rejection without throwing", async () => {
    const send = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const outcome = await postReleaseRecords({
      records: [RECORD],
      config: { ...CONFIGURED, configured: true },
      fetch: send,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.reason).toMatch(/500/);
  });

  it("reports a transport failure without throwing", async () => {
    const send = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const outcome = await postReleaseRecords({
      records: [RECORD],
      config: { ...CONFIGURED, configured: true },
      fetch: send,
    });

    expect(outcome).toEqual({ status: "failed", reason: "ECONNREFUSED" });
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
      config: { ...CONFIGURED, configured: true },
      fetch: send,
      timeoutMs: 5,
    });

    expect(outcome.status).toBe("failed");
  });

  // The token reaches one place: the Authorization header. A failure line goes to a public CI log.
  it("never puts the credential in what it reports", async () => {
    const send = vi.fn(async () => {
      throw new Error("failed to reach https://dashboard.pithy.sh with secret-token");
    }) as unknown as typeof fetch;

    const outcome = await postReleaseRecords({
      records: [RECORD],
      config: { ...CONFIGURED, configured: true },
      fetch: send,
    });

    expect(JSON.stringify(outcome)).not.toContain("secret-token");
  });

  it("never puts the credential in a rejection body it echoes", async () => {
    const send = vi.fn(
      async () => new Response("rejected token secret-token", { status: 403 }),
    ) as unknown as typeof fetch;

    const outcome = await postReleaseRecords({
      records: [RECORD],
      config: { ...CONFIGURED, configured: true },
      fetch: send,
    });

    expect(JSON.stringify(outcome)).not.toContain("secret-token");
  });
});
