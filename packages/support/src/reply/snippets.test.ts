// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { SupportInvalidCategoryError } from "../error/errors";
import {
  DEFAULT_SUPPORT_REPLIES,
  defineSupportReplies,
  repliesForCategory,
  resolveReplies,
  SNIPPET_TOKENS,
  SupportReplySnippet,
  type SupportReplySnippets,
} from "./snippets";

/** Run `fn`, and return the `SupportInvalidCategoryError` it threw. Fails loudly if it threw nothing. */
function invalidReply(fn: () => unknown): SupportInvalidCategoryError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SupportInvalidCategoryError) return error;
    throw error;
  }
  throw new Error("expected SupportInvalidCategoryError, nothing was thrown");
}

describe("DEFAULT_SUPPORT_REPLIES", () => {
  test("every shipped snippet parses against SupportReplySnippet", () => {
    for (const [key, snippet] of Object.entries(DEFAULT_SUPPORT_REPLIES)) {
      expect(SupportReplySnippet.safeParse(snippet).success, key).toBe(true);
    }
  });

  test("every shipped body leaves a blank an operator has to fill", () => {
    // The module says so, and it is the point of the catalog: a canned reply that could be sent
    // unread is how a support inbox starts insulting people. Nothing else in the package enforces it.
    for (const [key, snippet] of Object.entries(DEFAULT_SUPPORT_REPLIES)) {
      expect(snippet.body, key).toContain("___");
    }
  });

  test("every shipped body greets the sender through the documented token, never a hard-coded name", () => {
    for (const [key, snippet] of Object.entries(DEFAULT_SUPPORT_REPLIES)) {
      expect(snippet.body, key).toContain(SNIPPET_TOKENS.name);
    }
  });

  test("every category a snippet claims is one the shipped taxonomy declares", () => {
    // A snippet tagged with a category that no classifier can produce is a snippet that never
    // surfaces first — it would silently sink to the bottom of the picker forever.
    const shipped: SupportReplySnippets = DEFAULT_SUPPORT_REPLIES;
    const tagged = Object.values(shipped)
      .map((snippet) => snippet.category)
      .filter((category): category is string => category !== undefined);
    expect(tagged).toEqual(["billing", "billing", "account_access", "bug_report", "feature_request"]);
  });

  test("the shipped set passes the validator an adopter's set has to pass", () => {
    expect(() => defineSupportReplies(DEFAULT_SUPPORT_REPLIES)).not.toThrow();
  });
});

describe("defineSupportReplies", () => {
  test("rejects a key that is not snake_case, and names the key that broke it", () => {
    for (const key of ["Refund Issued", "1refund", "refund-issued"]) {
      const error = invalidReply(() =>
        defineSupportReplies({ [key]: { label: "Refund issued", body: "Hi {{name}}, ___." } }),
      );
      expect(error.payload.code, key).toBe("support/invalid_category");
      expect(error.payload.status, key).toBe(400);
      expect(error.message, key).toContain(key);
    }
  });

  test("rejects a snippet with an empty body, and names the snippet", () => {
    const error = invalidReply(() => defineSupportReplies({ refund_issued: { label: "Refund issued", body: "" } }));
    expect(error.payload.code).toBe("support/invalid_category");
    expect(error.message).toContain("refund_issued");
  });

  test("rejects a snippet with no label, and a body past the 2000-character bound", () => {
    // The bound keeps the catalog shippable in a manifest; the label is what the picker renders.
    expect(invalidReply(() => defineSupportReplies({ refund_issued: { label: "", body: "___" } })).payload.code).toBe(
      "support/invalid_category",
    );
    expect(() => defineSupportReplies({ long_one: { label: "Long", body: "x".repeat(2000) } })).not.toThrow();
    expect(
      invalidReply(() => defineSupportReplies({ long_one: { label: "Long", body: "x".repeat(2001) } })).message,
    ).toContain("long_one");
  });

  test("returns the same object it was given, so the declaration site keeps its literal types", () => {
    const declared = {
      dispute_ruled: { label: "Dispute ruled", body: "Hi {{name}},\n\nI've looked at this — ___.\n" },
    };
    expect(defineSupportReplies(declared)).toBe(declared);
  });
});

describe("resolveReplies", () => {
  test("with nothing added, the effective catalog is exactly the shipped one", () => {
    expect(resolveReplies()).toEqual({ ...DEFAULT_SUPPORT_REPLIES });
  });

  test("adds the adopter's snippets alongside the shipped ones", () => {
    const resolved = resolveReplies({ dispute_ruled: { label: "Dispute ruled", body: "Hi {{name}}, ___." } });
    expect(Object.keys(resolved)).toHaveLength(Object.keys(DEFAULT_SUPPORT_REPLIES).length + 1);
    expect(resolved.dispute_ruled?.label).toBe("Dispute ruled");
  });

  test("the adopter wins on a collision — shipped wording is theirs to rewrite", () => {
    const resolved = resolveReplies({ refund_issued: { label: "Refund sent", body: "Hi {{name}}, refunded. ___" } });
    expect(resolved.refund_issued?.label).toBe("Refund sent");
    // Rewriting a snippet replaces it; it must never leave two entries under the same key.
    expect(Object.keys(resolved)).toHaveLength(Object.keys(DEFAULT_SUPPORT_REPLIES).length);
  });

  test("validates what the adopter passes, so a bad key fails at composition rather than in the picker", () => {
    const error = invalidReply(() => resolveReplies({ "Dispute Ruled": { label: "Dispute ruled", body: "___" } }));
    expect(error.payload.code).toBe("support/invalid_category");
    expect(error.message).toContain("Dispute Ruled");
  });
});

describe("repliesForCategory", () => {
  const catalog = resolveReplies();
  const size = Object.keys(DEFAULT_SUPPORT_REPLIES).length;

  test("offers the matching category first, then the general-purpose ones, then the rest", () => {
    const keys = repliesForCategory(catalog, "billing").map((snippet) => snippet.key);
    expect(keys.slice(0, 2)).toEqual(["billing_explained", "refund_issued"]);
    // The uncategorized one is general-purpose, so it outranks a snippet tagged for another category.
    expect(keys[2]).toBe("need_more_detail");
    expect(keys.slice(3).sort()).toEqual(["bug_acknowledged", "feature_noted", "sign_in_help"]);
  });

  test("keeps every snippet, whatever the category — the model orders the list, it never restricts it", () => {
    // A classifier that filed a refund request under `bug_report` would otherwise hide the refund
    // snippets from the one person who can see it was wrong.
    for (const category of ["billing", "bug_report", "spam", "uncategorized", "not_a_category", ""]) {
      const offered = repliesForCategory(catalog, category);
      expect(offered, category).toHaveLength(size);
      expect(new Set(offered.map((snippet) => snippet.key)).size, category).toBe(size);
    }
  });

  test("with no snippet tagged for the thread's category, the general-purpose ones lead", () => {
    const keys = repliesForCategory(catalog, "spam").map((snippet) => snippet.key);
    expect(keys[0]).toBe("need_more_detail");
  });

  test("carries the key alongside the snippet, so a dashboard can post back what was picked", () => {
    const offered = repliesForCategory(catalog, "bug_report");
    expect(offered[0]).toEqual({ key: "bug_acknowledged", ...DEFAULT_SUPPORT_REPLIES.bug_acknowledged });
  });

  test("orders ties by key, so the picker does not reshuffle when the catalog is declared differently", () => {
    const reversed: SupportReplySnippets = Object.fromEntries(Object.entries(catalog).reverse());
    expect(repliesForCategory(reversed, "billing").map((snippet) => snippet.key)).toEqual(
      repliesForCategory(catalog, "billing").map((snippet) => snippet.key),
    );
  });

  test("ranks an adopter's snippet by its category, not by having shipped later", () => {
    const extended = resolveReplies({
      dispute_ruled: { label: "Dispute ruled", category: "billing", body: "Hi {{name}}, ___." },
    });
    const keys = repliesForCategory(extended, "billing").map((snippet) => snippet.key);
    expect(keys.slice(0, 3)).toEqual(["billing_explained", "dispute_ruled", "refund_issued"]);
  });
});
