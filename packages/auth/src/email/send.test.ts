// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { EnqueueResult } from "@pithy-sh/email/src/send/enqueue";
import { describe, expect, test } from "vitest";
import { type EnqueueEmail, makeSendAuthEmail } from "./send";

/**
 * The seam between auth's send callback and the email capability's enqueue. What it hands back is what the
 * trail and the verification ledger read: the job id is the only way the ledger can join a link to its mail
 * (#829), so both branches are pinned to carry it.
 */

type EnqueueInput = Parameters<EnqueueEmail>[0];

function fakeEnqueue(result: EnqueueResult): { enqueue: EnqueueEmail; calls: EnqueueInput[] } {
  const calls: EnqueueInput[] = [];
  return {
    calls,
    enqueue: async (input) => {
      calls.push(input);
      return result;
    },
  };
}

const QUEUED: EnqueueResult = { jobId: "job-1", status: "pending", subject: "Sign in" };

describe("makeSendAuthEmail", () => {
  test("a queued magic link carries its job id, with the url and the expiry as its payload", async () => {
    const { enqueue, calls } = fakeEnqueue(QUEUED);
    const send = makeSendAuthEmail(enqueue, 15);
    const delivery = await send({
      to: "ada@example.test",
      template: "magicLink",
      token: "t",
      url: "https://x.test/v?t",
    });
    expect(delivery).toEqual({ delivery: "queued", jobId: "job-1" });
    expect(calls).toEqual([
      { to: "ada@example.test", template: "magicLink", payload: { url: "https://x.test/v?t", expiresMinutes: 15 } },
    ]);
  });

  test("a queued code carries its job id, with the code and the expiry as its payload", async () => {
    const { enqueue, calls } = fakeEnqueue({ ...QUEUED, jobId: "job-2" });
    const send = makeSendAuthEmail(enqueue, 10);
    const delivery = await send({ to: "ada@example.test", template: "otp", code: "123456" });
    expect(delivery).toEqual({ delivery: "queued", jobId: "job-2" });
    expect(calls).toEqual([
      { to: "ada@example.test", template: "otp", payload: { code: "123456", expiresMinutes: 10 } },
    ]);
  });

  test("an undispatched send is still queued, with its job id", async () => {
    const { enqueue } = fakeEnqueue({ ...QUEUED, status: "undispatched" });
    const delivery = await makeSendAuthEmail(enqueue, 15)({ to: "a@example.test", template: "otp", code: "1" });
    expect(delivery).toEqual({ delivery: "queued", jobId: "job-1" });
  });

  test("a suppressed send is withheld, with its reason and the job id of the row that records it", async () => {
    const { enqueue } = fakeEnqueue({ ...QUEUED, status: "suppressed", suppressionReason: "hard_bounce" });
    const delivery = await makeSendAuthEmail(enqueue, 15)({ to: "a@example.test", template: "otp", code: "1" });
    expect(delivery).toEqual({ delivery: "withheld", reason: "hard_bounce", jobId: "job-1" });
  });

  test("a suppressed send with no reason falls back to the status, not a fabricated reason", async () => {
    const { enqueue } = fakeEnqueue({ ...QUEUED, status: "suppressed" });
    const delivery = await makeSendAuthEmail(
      enqueue,
      15,
    )({
      to: "a@example.test",
      template: "magicLink",
      token: "t",
      url: "https://x.test",
    });
    expect(delivery).toEqual({ delivery: "withheld", reason: "suppressed", jobId: "job-1" });
  });

  test("the recipient's locale rides onto the job for both templates, and is left off when nothing answers", async () => {
    const { enqueue, calls } = fakeEnqueue(QUEUED);
    const asked: string[] = [];
    const send = makeSendAuthEmail(enqueue, 15, async (email) => {
      asked.push(email);
      return email.startsWith("fr") ? "fr" : null;
    });
    await send({ to: "fr@example.test", template: "magicLink", token: "t", url: "https://x.test" });
    await send({ to: "fr@example.test", template: "otp", code: "1" });
    await send({ to: "en@example.test", template: "otp", code: "2" });
    expect(asked).toEqual(["fr@example.test", "fr@example.test", "en@example.test"]);
    expect(calls.map((call) => call.locale)).toEqual(["fr", "fr", undefined]);
    expect("locale" in (calls[2] ?? {})).toBe(false);
  });
});
