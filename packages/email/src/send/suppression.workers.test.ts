// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import type { EmailKind, SuppressionReason } from "../data/enums";
import { emailSuppressionDatabase } from "../data/tables";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { blockingSuppression, normalizeEmail, suppress, suppressionBlocks } from "./suppression";

/**
 * The suppression list read the way the send path reads it: address *and* kind.
 *
 * The table is keyed by address and holds no memory of which message a person was refusing, so the
 * reason column is the only thing that can tell an opt-out from a dead mailbox. Ignoring it is what made
 * one unsubscribe from a digest also withhold that person's magic link.
 */

const now = new Date("2026-06-18T12:00:00.000Z");

function db() {
  return emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
}

beforeEach(async () => {
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_suppressions.up(db());
});

describe("suppressionBlocks", () => {
  const matrix: Array<{ reason: SuppressionReason; kind: EmailKind; blocks: boolean }> = [
    // Facts about the mailbox. Both block everything: sending to a dead address is futile and sending
    // after a complaint is how a domain gets blocked outright — neither is softened by the message being
    // one somebody is waiting for.
    { reason: "hard_bounce", kind: "transactional", blocks: true },
    { reason: "hard_bounce", kind: "elective", blocks: true },
    { reason: "complaint", kind: "transactional", blocks: true },
    { reason: "complaint", kind: "elective", blocks: true },
    // An operator's deliberate act. Narrowing it would silently overrule the person who set it.
    { reason: "manual", kind: "transactional", blocks: true },
    { reason: "manual", kind: "elective", blocks: true },
    // The one reason that is a preference about a *category* of mail, and so the one a kind can narrow.
    { reason: "unsubscribe", kind: "elective", blocks: true },
    { reason: "unsubscribe", kind: "transactional", blocks: false },
  ];

  for (const { reason, kind, blocks } of matrix) {
    test(`${reason} ${blocks ? "blocks" : "does not block"} ${kind} mail`, () => {
      expect(suppressionBlocks(reason, kind)).toBe(blocks);
    });
  }
});

describe("blockingSuppression", () => {
  test("names the reason that blocked, so a caller can say why nothing was sent", async () => {
    await suppress(db(), { email: "dead@example.com", reason: "hard_bounce" }, now);
    expect(await blockingSuppression(db(), "dead@example.com", now, "transactional")).toBe("hard_bounce");
  });

  test("an unsubscribe reads as no block at all for transactional mail", async () => {
    await suppress(db(), { email: "ada@example.com", reason: "unsubscribe" }, now);
    expect(await blockingSuppression(db(), "ada@example.com", now, "transactional")).toBeNull();
    expect(await blockingSuppression(db(), "ada@example.com", now, "elective")).toBe("unsubscribe");
  });

  test("an address nobody blocked blocks nothing", async () => {
    expect(await blockingSuppression(db(), "fresh@example.com", now, "elective")).toBeNull();
  });

  test("the address is normalized on both sides of the question", async () => {
    await suppress(db(), { email: "  Ada@Example.COM ", reason: "complaint" }, now);
    expect(await blockingSuppression(db(), "ADA@example.com", now, "transactional")).toBe("complaint");
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  test("a lapsed suppression blocks nothing, and expiry exactly at now counts as lapsed", async () => {
    await suppress(db(), { email: "temp@example.com", reason: "hard_bounce", expiresAt: now }, now);
    expect(await blockingSuppression(db(), "temp@example.com", now, "elective")).toBeNull();
    const earlier = new Date(now.getTime() - 1);
    expect(await blockingSuppression(db(), "temp@example.com", earlier, "elective")).toBe("hard_bounce");
  });

  test("a reason nothing recognises blocks, rather than falling through to send", async () => {
    // The row crosses a trust boundary, and a value this code cannot read must not slip past the
    // `unsubscribe` test into "send it anyway". Written through raw SQL because the typed writer exists
    // precisely to make this unreachable — a future migration or a hand-edited row is what it guards.
    await env.EMAIL_SUPPRESSIONS.prepare(
      "insert into pithy_email_suppressions (email, reason, created_at) values (?, ?, ?)",
    )
      .bind("odd@example.com", "vendor_block", now.getTime())
      .run();
    expect(await blockingSuppression(db(), "odd@example.com", now, "transactional")).toBe("manual");
  });
});
