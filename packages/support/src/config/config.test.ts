// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  DEFAULT_CLASSIFY_MODEL,
  MAX_SUBMISSION_BODY_CHARS,
  MAX_SUBMISSION_SUBJECT_CHARS,
  SupportConfig,
} from "./config";

describe("SupportConfig defaults", () => {
  test("an empty object parses, so an adopter can compose the capability before configuring it", () => {
    expect(() => SupportConfig.parse({})).not.toThrow();
  });

  test("classification is on, deterministic, and bounded by default", () => {
    expect(SupportConfig.parse({}).ai).toEqual({
      enabled: true,
      model: DEFAULT_CLASSIFY_MODEL,
      maxChars: 4000,
      // Zero, not undefined: a reclassification pass has to agree with the first one.
      temperature: 0,
    });
  });

  test("attachments are stored by default, capped at 10 MiB and 10 files a message", () => {
    expect(SupportConfig.parse({}).attachments).toEqual({
      enabled: true,
      maxBytes: 10 * 1024 * 1024,
      maxCount: 10,
      retainRaw: true,
    });
  });

  test("the in-app channel is served by default, with its own bounds rather than the mail path's", () => {
    const submission = SupportConfig.parse({}).submission;
    expect(submission.enabled).toBe(true);
    expect(submission.maxSubjectChars).toBe(200);
    expect(submission.maxBodyChars).toBe(10_000);
    // Smaller than the mail path's 20-an-hour, and safe at that size for a reason mail cannot claim:
    // a submission is attributable to an account the adopter issued and can revoke.
    expect(submission.maxPerAccountPerHour).toBe(10);
  });

  test("a configured bound may not exceed the ceiling the route's own schema is written to", () => {
    // The two layers must not disagree. A setting above the ceiling would be a limit the route
    // silently refused to honor, which is worse than a refusal at config time.
    expect(() => SupportConfig.parse({ submission: { maxSubjectChars: MAX_SUBMISSION_SUBJECT_CHARS + 1 } })).toThrow();
    expect(() => SupportConfig.parse({ submission: { maxBodyChars: MAX_SUBMISSION_BODY_CHARS + 1 } })).toThrow();
    expect(() => SupportConfig.parse({ submission: { maxSubjectChars: MAX_SUBMISSION_SUBJECT_CHARS } })).not.toThrow();
  });

  test("the guard bounds are present without being asked for — a public address is a public write endpoint", () => {
    expect(SupportConfig.parse({}).guard).toEqual({
      maxRawBytes: 2 * 1024 * 1024,
      maxPerSenderPerHour: 20,
      maxPerHour: 500,
      // Spam is a filter, not a bin: a classifier that deleted mail would be untrustworthy the first
      // time it was wrong.
      trustAuthenticationResults: false,
      archiveSpam: true,
    });
  });

  test("replies are allowed by default, with no reply-to override and no adopter snippets", () => {
    const reply = SupportConfig.parse({}).reply;
    expect(reply.enabled).toBe(true);
    expect(reply.replyToAddress).toBeUndefined();
    expect(reply.snippets).toEqual({});
    // In-app delivery is chosen or fallen back to, never drifted into: a project whose mail works
    // keeps mailing its answers until somebody says otherwise.
    expect(reply.deliverInApp).toBe(false);
  });

  test("FTS5 is off by default — an FTS5 table anywhere in a D1 database breaks `wrangler d1 export`", () => {
    // Deliberate, and not a performance call. D1 refuses to export *any* database containing an FTS5
    // virtual table, and the check runs before `--table` filtering — so defaulting this on would take
    // the adopter's entire app database's backups with it, not just the support tables. If this ever
    // flips to `true`, that is the regression this test exists to catch.
    expect(SupportConfig.parse({}).search.fts).toBe(false);
  });

  test("no addresses are claimed by default, so the inbox is inert until an adopter names one", () => {
    // Email Routing takes over a zone's MX, so this capability will not guess an address. Empty here
    // is what makes every inbound message a no-op rather than mail stored from an unconfigured inbox.
    expect(SupportConfig.parse({}).inboundAddresses).toEqual([]);
    expect(SupportConfig.parse({}).categories).toEqual({});
  });
});

describe("SupportConfig partial overrides", () => {
  test("overriding one field of a nested block keeps that block's other defaults", () => {
    // This is what `.prefault({})` on each block buys. Without it, `{ ai: { temperature: 0.7 } }`
    // would either fail for the missing keys or land a block with `model` undefined.
    const config = SupportConfig.parse({ ai: { temperature: 0.7 } });
    expect(config.ai.temperature).toBe(0.7);
    expect(config.ai.enabled).toBe(true);
    expect(config.ai.model).toBe(DEFAULT_CLASSIFY_MODEL);
    expect(config.ai.maxChars).toBe(4000);
  });

  test("overriding one block leaves its sibling blocks fully defaulted", () => {
    const config = SupportConfig.parse({ search: { fts: true } });
    expect(config.search.fts).toBe(true);
    expect(config.guard.maxPerHour).toBe(500);
    expect(config.attachments.maxBytes).toBe(10 * 1024 * 1024);
    expect(config.reply.enabled).toBe(true);
  });

  test("turning classification off leaves the model recorded, so the setting is reversible", () => {
    const config = SupportConfig.parse({ ai: { enabled: false } });
    expect(config.ai.enabled).toBe(false);
    expect(config.ai.model).toBe(DEFAULT_CLASSIFY_MODEL);
  });
});

describe("SupportConfig rejects out-of-range values", () => {
  test("a negative attachment cap is refused rather than silently storing nothing", () => {
    expect(SupportConfig.safeParse({ attachments: { maxBytes: -1 } }).success).toBe(false);
    expect(SupportConfig.safeParse({ attachments: { maxCount: 0 } }).success).toBe(false);
  });

  test("a temperature above 2 is refused — Workers AI would reject it at call time instead", () => {
    expect(SupportConfig.safeParse({ ai: { temperature: 2.5 } }).success).toBe(false);
    expect(SupportConfig.safeParse({ ai: { temperature: -0.1 } }).success).toBe(false);
    expect(SupportConfig.safeParse({ ai: { temperature: 2 } }).success).toBe(true);
  });

  test("a fractional or zero guard bound is refused, because these are counts", () => {
    expect(SupportConfig.safeParse({ guard: { maxPerHour: 0 } }).success).toBe(false);
    expect(SupportConfig.safeParse({ guard: { maxPerSenderPerHour: 1.5 } }).success).toBe(false);
    expect(SupportConfig.safeParse({ guard: { maxRawBytes: -2048 } }).success).toBe(false);
  });

  test("an address too short to be one is refused where it is written", () => {
    expect(SupportConfig.safeParse({ inboundAddresses: ["a"] }).success).toBe(false);
  });
});

describe("SupportConfig adopter records", () => {
  test("an adopter's categories survive parsing verbatim — the value lands in the prompt as written", () => {
    const categories = {
      partner_request: "A partner or reseller asking about integration terms.",
      data_export: "Somebody asking for a copy or deletion of their data.",
    };
    const config = SupportConfig.parse({ inboundAddresses: ["support@help.example.com"], categories });
    expect(config.categories).toEqual(categories);
    expect(config.inboundAddresses).toEqual(["support@help.example.com"]);
  });

  test("an adopter's reply snippets survive parsing with their optional category intact", () => {
    const snippets = {
      partner_intro: {
        label: "Partner intro",
        category: "partner_request",
        body: "Hi {{name}},\n\nThanks for getting in touch about ___.\n",
      },
      general_thanks: { label: "Thanks", body: "Hi {{name}},\n\nThanks — ___.\n" },
    };
    const config = SupportConfig.parse({ reply: { snippets } });
    expect(config.reply.snippets).toEqual(snippets);
    // An optional field that quietly disappeared would drop a snippet out of its category ordering.
    expect(config.reply.snippets.partner_intro?.category).toBe("partner_request");
    expect(config.reply.snippets.general_thanks?.category).toBeUndefined();
  });

  test("a snippet missing a body is refused, so a broken picker entry fails at config time", () => {
    expect(SupportConfig.safeParse({ reply: { snippets: { broken: { label: "Broken" } } } }).success).toBe(false);
  });
});
