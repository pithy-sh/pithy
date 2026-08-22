// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { MAX_SUBMISSION_ATTACHMENTS, SupportSubmissionConfig } from "../config/config";
import { checkAttachment } from "./guard";

/**
 * The attachment half of the submission guard — the half that needs no database.
 *
 * The rate half is exercised against real D1 in `submit.workers.test.ts`, because a sliding window over
 * a table is a thing only SQLite can answer honestly.
 */

const CONFIG = SupportSubmissionConfig.parse({});

describe("submission attachment bounds", () => {
  test("the shipped allowlist is what a bug report is made of", () => {
    // Pinned rather than described, because the default *is* the security decision: an allowlist that
    // grew a type by accident is the failure this shape exists to prevent, and a diff on this line is
    // the review it deserves.
    expect(CONFIG.attachments.allowedContentTypes).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "application/pdf",
      "text/plain",
    ]);
  });

  test("the bounds are the submission's own, not the mail path's", () => {
    // The point of AC7: these numbers are stated here rather than inherited. A direct upload from an
    // authenticated but untrusted client is a different surface from a MIME part somebody mailed in,
    // and the smaller size and count are what say so.
    expect(CONFIG.attachments.maxBytes).toBe(5 * 1024 * 1024);
    expect(CONFIG.attachments.maxCount).toBe(3);
  });

  test("an allowed type inside the size bound is accepted", () => {
    expect(checkAttachment(CONFIG, { contentType: "image/png", bytes: 1024 })).toEqual({ accepted: true });
  });

  test("exactly at the size bound is accepted, one byte over is not", () => {
    expect(checkAttachment(CONFIG, { contentType: "image/png", bytes: CONFIG.attachments.maxBytes })).toEqual({
      accepted: true,
    });
    const over = checkAttachment(CONFIG, { contentType: "image/png", bytes: CONFIG.attachments.maxBytes + 1 });
    expect(over.accepted).toBe(false);
    expect(over.accepted === false && over.reason).toBe("attachment_too_large");
  });

  test("a type nobody listed is refused rather than accepted", () => {
    // An allowlist, so the interesting case is the type nobody thought about. A denylist would have
    // let this through, which is the whole reason the default runs the other way.
    const verdict = checkAttachment(CONFIG, { contentType: "text/html", bytes: 10 });
    expect(verdict.accepted).toBe(false);
    expect(verdict.accepted === false && verdict.reason).toBe("attachment_type");
  });

  test("the type comparison is exact — no prefix or wildcard match", () => {
    // `image/png; charset=utf-8` and `IMAGE/PNG` both name something the allowlist arguably covers, and
    // both are refused: a guard that normalizes is a guard with a parser in it, and the parser is where
    // the bypass lives. The schema already constrains the string to lowercase `type/subtype`.
    expect(checkAttachment(CONFIG, { contentType: "image/png2", bytes: 10 }).accepted).toBe(false);
    expect(checkAttachment(CONFIG, { contentType: "image/", bytes: 10 }).accepted).toBe(false);
  });

  test("the size bound is checked before the type, so a huge disallowed file reports its size", () => {
    // Ordering is the same principle the mail guard states: refuse on the cheapest true reason. A
    // client that fixed the type and resent five megabytes would otherwise learn about the size bound
    // only on the second attempt.
    const verdict = checkAttachment(CONFIG, { contentType: "text/html", bytes: CONFIG.attachments.maxBytes + 1 });
    expect(verdict.accepted === false && verdict.reason).toBe("attachment_too_large");
  });

  test("a configured count above the absolute ceiling is refused at config time", () => {
    // The ceiling is what the route's own schema is written to. A setting above it would be a limit
    // the validator silently refused to honor — the same two-layer rule the length bounds follow.
    expect(() =>
      SupportSubmissionConfig.parse({ attachments: { maxCount: MAX_SUBMISSION_ATTACHMENTS + 1 } }),
    ).toThrow();
    expect(() =>
      SupportSubmissionConfig.parse({ attachments: { maxCount: MAX_SUBMISSION_ATTACHMENTS } }),
    ).not.toThrow();
  });

  test("an adopter's own allowlist replaces the default rather than extending it", () => {
    const strict = SupportSubmissionConfig.parse({ attachments: { allowedContentTypes: ["image/png"] } });
    expect(checkAttachment(strict, { contentType: "image/png", bytes: 10 }).accepted).toBe(true);
    expect(checkAttachment(strict, { contentType: "application/pdf", bytes: 10 }).accepted).toBe(false);
  });
});
