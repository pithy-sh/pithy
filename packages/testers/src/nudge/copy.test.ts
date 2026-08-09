// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { NudgeKind } from "../data/enums";
import { answersRecentAction } from "./cooldown";
import { defaultCopy, resolveCopy, sanitizeSubject, toParagraphs } from "./copy";

/**
 * Derived from the enum, not restated beside it.
 *
 * The hand-maintained list omitted `store` — the second of the two emails, and the only one carrying
 * the link that joins the test — so both "every nudge kind" suites skipped it entirely. Its subject
 * could be emptied, or its call-to-action label replaced with markup, and the whole suite stayed green.
 */
const KINDS: NudgeKind[] = [...NudgeKind.options];

describe("the shipped defaults", () => {
  test("every nudge kind ships usable copy, so the library is not gated behind a dashboard", () => {
    // The requirement the issue states outright: the CLI must say something sensible
    // with nothing supplied. A missing default would functionally paywall the capability.
    for (const kind of KINDS) {
      const copy = defaultCopy(kind);
      expect(copy.subject.length).toBeGreaterThan(0);
      expect(copy.heading.length).toBeGreaterThan(0);
      expect(copy.paragraphs.length).toBeGreaterThan(0);
      for (const paragraph of copy.paragraphs) expect(paragraph.length).toBeGreaterThan(20);
    }
  });

  test("carries no markup of its own, so the template's escaping is never load-bearing for our own text", () => {
    for (const kind of KINDS) {
      const copy = defaultCopy(kind);
      for (const text of [copy.subject, copy.heading, ...copy.paragraphs]) {
        expect(text).not.toMatch(/[<>]/);
      }
    }
  });
});

describe("splitting a supplied body into paragraphs", () => {
  test("blank lines separate paragraphs", () => {
    expect(toParagraphs("First para.\n\nSecond para.")).toEqual(["First para.", "Second para."]);
  });

  test("a hard-wrapped paragraph collapses to one, not a column of stanzas", () => {
    expect(toParagraphs("A sentence that was\nwrapped in a terminal.")).toEqual([
      "A sentence that was wrapped in a terminal.",
    ]);
  });

  test("empty and whitespace-only input yields no paragraphs at all", () => {
    // Which is what lets `resolveCopy` fall back to the default rather than sending a blank email.
    expect(toParagraphs("")).toEqual([]);
    expect(toParagraphs("   \n\n  \n ")).toEqual([]);
  });

  test("control characters are stripped, bidi overrides included", () => {
    // They cannot become markup, but a right-to-left override renders the text after it reversed,
    // which is how an approved-looking sentence displays as something else.
    //
    // **Constructed, never typed.** Both used to sit in this line as themselves: the override reordered
    // the line in every reviewer's editor, and the BEL was invisible in the diff — which is #221, and
    // `cli/src/ci/sourceFiles.test.ts` now fails the build on either. The input is byte-identical; only
    // the spelling changed. `\0` is #216's escape, left where it is for the same argument.
    const override = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(0x07);
    const dirty = `Please\0 confirm${override} your place${bell}.`;
    expect(toParagraphs(dirty)).toEqual(["Please confirm your place."]);
  });

  test("the paragraph count is bounded, so a body cannot become a thousand-stanza email", () => {
    const many = Array.from({ length: 200 }, (_, index) => `Para ${index}.`).join("\n\n");
    expect(toParagraphs(many, 20)).toHaveLength(20);
  });

  test("markup in a supplied body survives as literal text rather than being stripped", () => {
    // Deliberate. This function does not sanitize; the template's `{{this}}` escaping is what makes
    // markup safe, and that is structural rather than a filter that must anticipate every trick. What
    // arrives here is what a recipient will read, as text.
    expect(toParagraphs("<script>alert(1)</script>")).toEqual(["<script>alert(1)</script>"]);
  });
});

describe("resolving copy", () => {
  test("no override yields the shipped default, marked as such", () => {
    const copy = resolveCopy("confirm", undefined);
    expect(copy.subject).toBe(defaultCopy("confirm").subject);
    expect(copy.source).toBe("default");
  });

  test("a supplied subject and body are used, and the send is marked as supplied", () => {
    // The provenance is recorded on the email job: a message going out over the adopter's own DKIM
    // signature should be attributable to whoever wrote the words.
    const copy = resolveCopy("confirm", { subject: "Two minutes, please", body: "Hi.\n\nPlease confirm." });
    expect(copy.subject).toBe("Two minutes, please");
    expect(copy.paragraphs).toEqual(["Hi.", "Please confirm."]);
    expect(copy.source).toBe("supplied");
  });

  test("a partial override keeps the default for the half that was not supplied", () => {
    const subjectOnly = resolveCopy("inactive", { subject: "Checking in" });
    expect(subjectOnly.subject).toBe("Checking in");
    expect(subjectOnly.paragraphs).toEqual(defaultCopy("inactive").paragraphs);

    const bodyOnly = resolveCopy("inactive", { body: "Just checking." });
    expect(bodyOnly.subject).toBe(defaultCopy("inactive").subject);
    expect(bodyOnly.paragraphs).toEqual(["Just checking."]);
  });

  test("an override that is entirely whitespace falls back rather than sending a blank email", () => {
    const copy = resolveCopy("closing", { subject: "   ", body: "\n\n  \n" });
    expect(copy.subject).toBe(defaultCopy("closing").subject);
    expect(copy.paragraphs).toEqual(defaultCopy("closing").paragraphs);
    expect(copy.source).toBe("default");
  });

  test("the heading is never overridable — the envelope is always ours", () => {
    // The rule the whole override design turns on: a caller authors words, this capability owns the
    // shell. Letting the heading through would be the first crack in that.
    const copy = resolveCopy("confirm", { subject: "x", body: "y" });
    expect(copy.heading).toBe(defaultCopy("confirm").heading);
  });
});

describe("sanitizing a supplied subject", () => {
  test("strips CR and LF, which is what stops a subject becoming an injected header", () => {
    // The actual threat in a subject line. A bare newline can terminate the header and let everything
    // after it be read as another one — which is how a supplied subject becomes a Bcc.
    expect(sanitizeSubject("Still testing?\r\nBcc: victim@example.com")).toBe("Still testing? Bcc: victim@example.com");
    expect(sanitizeSubject("Still testing?\nX-Injected: yes")).toBe("Still testing? X-Injected: yes");
    for (const injected of ["\r", "\n", "\u0000", "\u001f", "\u007f"]) {
      expect(sanitizeSubject(`a${injected}b`)).not.toContain(injected);
    }
  });

  test("strips bidi overrides, which can make a subject read as something it is not", () => {
    expect(sanitizeSubject("Confirm\u202Eyour place")).toBe("Confirm your place");
  });

  test("collapses whitespace so a multi-line paste arrives as one line", () => {
    expect(sanitizeSubject("  Two   words \n  here  ")).toBe("Two words here");
  });

  test("leaves markup alone, because a subject is text and escaping it would render entities in inboxes", () => {
    // The division of labour with the email renderer: it precompiles subjects with escaping off, and
    // this function owns the only threat that actually applies there.
    expect(sanitizeSubject("<b>Still testing?</b>")).toBe("<b>Still testing?</b>");
  });

  test("a supplied subject reaches resolveCopy already sanitized", () => {
    const copy = resolveCopy("inactive", { subject: "Checking in\r\nBcc: victim@example.com" });
    expect(copy.subject).not.toContain("\r");
    expect(copy.subject).not.toContain("\n");
  });

  test("a subject that sanitizes down to nothing falls back to the default", () => {
    const copy = resolveCopy("inactive", { subject: "\r\n\u0000  " });
    expect(copy.subject).toBe(defaultCopy("inactive").subject);
    expect(copy.source).toBe("default");
  });
});

describe("a reply is not a chase", () => {
  const base = { acceptedAt: null, lastNudgedAt: null } as unknown as Parameters<typeof answersRecentAction>[0];

  test("a tester who just agreed and has not heard back is owed a reply", () => {
    // The cooldown exists to stop repeated chasing. Holding the link a tester just asked for, because we
    // happened to message them two days ago, is how a cohort loses the people who were most willing.
    const agreed = {
      ...base,
      acceptedAt: new Date("2026-06-02T10:00:00Z"),
      lastNudgedAt: new Date("2026-06-01T05:00:00Z"),
    };
    expect(answersRecentAction(agreed)).toBe(true);
  });

  test("a tester who agreed and has already been answered falls back under the cooldown", () => {
    const answered = {
      ...base,
      acceptedAt: new Date("2026-06-02T10:00:00Z"),
      lastNudgedAt: new Date("2026-06-02T11:00:00Z"),
    };
    expect(answersRecentAction(answered)).toBe(false);
  });

  test("a tester who agreed and has never been messaged is owed one", () => {
    expect(answersRecentAction({ ...base, acceptedAt: new Date("2026-06-02T10:00:00Z") })).toBe(true);
  });

  test("a tester who has not agreed is never owed a reply", () => {
    // Nothing to answer. Every message to them is outreach, and outreach is what the cooldown governs.
    expect(answersRecentAction(base)).toBe(false);
  });
});
