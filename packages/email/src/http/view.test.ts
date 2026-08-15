// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { EmailJob } from "../data/emailJob";
import type { EmailSuppression } from "../data/emailSuppression";
import { jobDetailView, jobListView, maskAddress, suppressionView } from "./view";

/**
 * The projections, tested as the security boundary they are.
 *
 * A response projection is not formatting. It is the line between what a management credential asked
 * for and what it is allowed to receive, and the failure mode is silent: a field added to `EmailJob`
 * and spread into a response leaks on every request from then on, with nothing red anywhere. So these
 * assert on *absence* as much as presence, and against the serialized body rather than the object, so a
 * value nested somewhere unexpected is still caught.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");

/** A job carrying the worst payload this capability actually sends: a sign-in link and a person. */
function job(overrides: Partial<EmailJob> = {}): EmailJob {
  return {
    id: "job-1",
    toAddress: "ada.lovelace@example.com",
    recipientKey: "ada.lovelace@example.com",
    fromAddress: "noreply@pithy.sh",
    fromName: "Pithy",
    subject: "Your sign-in link",
    template: "magicLink",
    category: "transactional",
    payload: {
      name: "Ada Lovelace",
      url: "https://api.example.test/auth/magic?token=SUPER-SECRET-SIGN-IN-TOKEN",
      address: "12 Marylebone Road, London",
    },
    status: "failed",
    mode: "immediate",
    attempts: 3,
    sendAt: NOW,
    timezone: null,
    localTime: null,
    campaignId: null,
    openTracking: false,
    clickTracking: false,
    messageId: null,
    error: "550 5.1.1 <ada.lovelace@example.com> user unknown",
    bounceCode: null,
    bounceType: null,
    replyTo: null,
    inReplyTo: null,
    references: null,
    createdAt: NOW,
    updatedAt: NOW,
    sentAt: null,
    ...overrides,
  };
}

describe("the template payload never leaves the Worker", () => {
  test("the list projection carries no part of it", () => {
    // The decisive case. A `magicLink` payload holds a working sign-in URL, so projecting it on a read
    // scope would turn the least privileged credential this capability defines into account takeover
    // for every user who requested a link recently.
    const body = JSON.stringify(jobListView(job()));
    expect(body).not.toContain("SUPER-SECRET-SIGN-IN-TOKEN");
    expect(body).not.toContain("Ada Lovelace");
    expect(body).not.toContain("Marylebone");
    expect(body).not.toContain("payload");
  });

  test("nor does the detail projection, which is the route that discloses the most", () => {
    const body = JSON.stringify(jobDetailView(job()));
    expect(body).not.toContain("SUPER-SECRET-SIGN-IN-TOKEN");
    expect(body).not.toContain("Ada Lovelace");
    expect(body).not.toContain("Marylebone");
    expect(body).not.toContain("payload");
  });
});

describe("the list masks the recipient and the detail does not", () => {
  test("the list shows two characters and the domain", () => {
    expect(jobListView(job()).recipient).toBe("ad***@example.com");
  });

  test("the list carries no whole address anywhere, error strings included", () => {
    // Provider errors routinely embed the recipient — `550 5.1.1 <ada@example.com> user unknown` — so
    // the list carries a boolean and the text stays on the detail route, behind the request that
    // discloses the address anyway.
    const view = jobListView(job());
    const body = JSON.stringify(view);
    expect(body).not.toContain("ada.lovelace@example.com");
    expect(view.failed).toBe(true);
  });

  test("a healthy job is not reported as failed", () => {
    expect(jobListView(job({ status: "sent", error: null, sentAt: NOW })).failed).toBe(false);
  });

  test("the detail gives the whole address, the subject, and the error", () => {
    const view = jobDetailView(job());
    expect(view.toAddress).toBe("ada.lovelace@example.com");
    expect(view.subject).toBe("Your sign-in link");
    expect(view.error).toContain("550");
  });

  test("the detail does not smuggle the masked field back in beside the real one", () => {
    expect(Object.keys(jobDetailView(job()))).not.toContain("recipient");
  });
});

describe("masking refuses to echo what it cannot parse", () => {
  test("an ordinary address keeps its domain", () => {
    expect(maskAddress("someone@long.example.co.uk")).toBe("so***@long.example.co.uk");
  });

  test("a one-character local part is not padded out to look longer", () => {
    expect(maskAddress("a@example.com")).toBe("a***@example.com");
  });

  test("anything that is not an address at all collapses", () => {
    // The value a mask exists for is exactly the value that escapes it if an unparseable string is
    // passed through unchanged.
    for (const bad of ["", "not-an-address", "@example.com", "trailing@", "@"]) {
      expect(maskAddress(bad), bad).toBe("***");
    }
  });

  test("an address with an @ in the local part masks on the last one", () => {
    expect(maskAddress('"weird@local"@example.com')).toBe('"w***@example.com');
  });
});

describe("the suppression view", () => {
  const row = (overrides: Partial<EmailSuppression> = {}): EmailSuppression => ({
    id: 7,
    email: "blocked@example.com",
    reason: "hard_bounce",
    jobId: "job-9",
    environment: "prod",
    detail: "550 mailbox unavailable",
    createdAt: NOW,
    expiresAt: null,
    ...overrides,
  });

  test("keeps the address, because the address is the record", () => {
    // Masking here would leave a list of blocks nobody could act on. That disclosure is why reading
    // this list is its own scope rather than part of `email:jobs:read`.
    expect(suppressionView(row(), NOW).email).toBe("blocked@example.com");
  });

  test("answers whether the block is in force, rather than making every client work it out", () => {
    expect(suppressionView(row(), NOW).active).toBe(true);
    expect(suppressionView(row({ expiresAt: new Date(NOW.getTime() + 1000) }), NOW).active).toBe(true);
    expect(suppressionView(row({ expiresAt: new Date(NOW.getTime() - 1000) }), NOW).active).toBe(false);
    // The boundary: `blockingSuppression` treats an expiry exactly at `now` as lifted, and this must agree
    // with it or an operator is told a block is holding mail that is already going out.
    expect(suppressionView(row({ expiresAt: NOW }), NOW).active).toBe(false);
  });
});
