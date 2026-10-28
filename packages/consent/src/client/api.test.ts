// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { CONSENT_UNREADABLE, type ConsentFetch, type ConsentRequestInit, consentClient } from "./api";

/** A fetch that answers one status and body, and records what it was asked. */
function answering(status: number, body: unknown) {
  const calls: { url: string; init?: ConsentRequestInit }[] = [];
  const fake: ConsentFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 300, status, json: async () => body };
  };
  return { fake, calls };
}

const PURPOSE = {
  id: "email.marketing",
  summary: "News by email.",
  noticeVersion: 1,
  classes: [],
  explicit: false,
  minimumMethod: "click",
  writtenWithdrawal: false,
};

describe("consentClient", () => {
  test("reads the caller's own consents under the configured base path, validated", async () => {
    const { fake, calls } = answering(200, {
      subject: null,
      purposes: [{ purpose: PURPOSE, standing: "never_granted", granted: false }],
      records: [],
    });
    const result = await consentClient({ basePath: "/privacy", fetch: fake }).me();
    expect(calls[0]?.url).toBe("/privacy/me");
    expect(result.ok && result.value.purposes[0]?.purpose.id).toBe("email.marketing");
  });

  test("posts a withdrawal as JSON, the same shape a grant is", async () => {
    const { fake, calls } = answering(400, { error: { code: "consent/withdrawal_below_grant", message: "Sign it." } });
    const result = await consentClient({ fetch: fake }).withdraw({
      purpose: "clinic.records",
      method: "click",
      surface: "settings",
    });
    expect(calls[0]?.url).toBe("/consent/withdrawals");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ purpose: "clinic.records" });
    expect(result).toEqual({ ok: false, code: "consent/withdrawal_below_grant", message: "Sign it." });
  });

  test("an answer in the wrong shape is a refusal, never a value", async () => {
    const { fake } = answering(200, { purposes: "nope" });
    const result = await consentClient({ fetch: fake }).purposes();
    expect(result.ok ? "" : result.code).toBe(CONSENT_UNREADABLE);
  });

  test("an unreachable Worker is a refusal, never a throw", async () => {
    const failing: ConsentFetch = async () => {
      throw new TypeError("offline");
    };
    const result = await consentClient({ fetch: failing }).me();
    expect(result.ok ? "" : result.code).toBe("network/unreachable");
  });
});
