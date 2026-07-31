// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  buildReferencesHeader,
  MAX_REFERENCES,
  mintMessageId,
  normalizeMessageId,
  parentCandidates,
  parseReferences,
  replySubject,
} from "./threading";

/** `n` distinct ids, oldest first, the way a long thread's `References` reads. */
function chain(n: number): string[] {
  return Array.from({ length: n }, (_, index) => `id-${index}@example.com`);
}

describe("normalizeMessageId", () => {
  test("strips the angle brackets, because storage and lookup must agree", () => {
    // One path storing `<a@b>` while another queries `a@b` is a threading bug that only shows up on
    // the first reply — by which point the customer already sees two conversations.
    expect(normalizeMessageId("<abc@example.com>")).toBe("abc@example.com");
  });

  test("leaves an already-bare id alone, so normalizing twice is a no-op", () => {
    expect(normalizeMessageId("abc@example.com")).toBe("abc@example.com");
    expect(normalizeMessageId(normalizeMessageId("<abc@example.com>"))).toBe("abc@example.com");
  });

  test("strips doubled brackets and surrounding space", () => {
    expect(normalizeMessageId("  <<abc@example.com>>  ")).toBe("abc@example.com");
  });

  test("rejects a value with internal whitespace — that was a list, not an id", () => {
    // A caller that hands a whole `References` header to this function gets nothing back rather than a
    // garbage id, which is what pushes them to `parseReferences` instead of silently threading wrong.
    expect(normalizeMessageId("<a@example.com> <b@example.com>")).toBeUndefined();
    expect(normalizeMessageId("a@example.com b@example.com")).toBeUndefined();
    expect(normalizeMessageId("a@example.com\r\n\tb@example.com")).toBeUndefined();
  });

  test("bounds the id at 512 characters", () => {
    const atLimit = "a".repeat(512);
    expect(normalizeMessageId(atLimit)).toBe(atLimit);
    expect(normalizeMessageId("a".repeat(513))).toBeUndefined();
  });

  test("measures the bound after unwrapping, so brackets do not count against a valid id", () => {
    expect(normalizeMessageId(`<${"a".repeat(512)}>`)).toHaveLength(512);
  });

  test("returns undefined for missing and empty input rather than throwing", () => {
    expect(normalizeMessageId(undefined)).toBeUndefined();
    expect(normalizeMessageId(null)).toBeUndefined();
    expect(normalizeMessageId("")).toBeUndefined();
    expect(normalizeMessageId("<>")).toBeUndefined();
    expect(normalizeMessageId("   ")).toBeUndefined();
  });
});

describe("parseReferences", () => {
  test("splits the bracketed form a conforming client sends", () => {
    expect(parseReferences("<a@example.com> <b@example.com> <c@example.com>")).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });

  test("falls back to whitespace when a hand-rolled sender omitted the brackets", () => {
    expect(parseReferences("a@example.com b@example.com")).toEqual(["a@example.com", "b@example.com"]);
  });

  test("survives the folding whitespace a real header arrives with", () => {
    expect(parseReferences("a@example.com\r\n\tb@example.com")).toEqual(["a@example.com", "b@example.com"]);
  });

  test("the brackets win when present — an unbracketed tail is not a second syntax", () => {
    // Mixing the two would let a crafted header smuggle an extra id past the bracket delimiter.
    expect(parseReferences("<a@example.com> b@example.com")).toEqual(["a@example.com"]);
  });

  test("keeps the header's oldest-first order", () => {
    // The order is the ancestry, and `parentCandidates` reads it back to front. Sorting or reversing
    // here would attach a reply to the root of a long thread instead of to the message it answers.
    expect(parseReferences("<root@example.com> <mid@example.com> <near@example.com>")).toEqual([
      "root@example.com",
      "mid@example.com",
      "near@example.com",
    ]);
  });

  test("deduplicates, keeping the first appearance", () => {
    expect(parseReferences("<a@example.com> <b@example.com> <a@example.com>")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  test("drops entries that are not ids at all", () => {
    expect(parseReferences("<> <a@example.com> <>")).toEqual(["a@example.com"]);
  });

  test("caps the chain at MAX_REFERENCES, keeping the newest entries and dropping the oldest", () => {
    // Unbounded by spec, so a single message could otherwise hand the parent lookup thousands of keys.
    //
    // The *direction* of the cap is the load-bearing part. `parentCandidates` reads this list from the
    // newest end backwards, because the nearest ancestor is the message a reply actually answers — so
    // trimming the newest end would throw away exactly the ids the lookup wants first, and a long
    // thread would silently stop threading on `References`. RFC 5322 §3.6.4 says to trim this end too.
    const parsed = parseReferences(
      chain(MAX_REFERENCES + 20)
        .map((id) => `<${id}>`)
        .join(" "),
    );
    expect(parsed).toHaveLength(MAX_REFERENCES);
    expect(parsed[0]).toBe("id-20@example.com");
    expect(parsed.at(-1)).toBe(`id-${MAX_REFERENCES + 19}@example.com`);
  });

  test("the surviving entries are the ones parentCandidates asks about first", () => {
    // The cap and the lookup order agree, which is the property that actually matters: the newest
    // reference must still be the first thing a parent lookup tries after `In-Reply-To`.
    const parsed = parseReferences(
      chain(MAX_REFERENCES + 20)
        .map((id) => `<${id}>`)
        .join(" "),
    );
    expect(parentCandidates(undefined, parsed)[0]).toBe(`id-${MAX_REFERENCES + 19}@example.com`);
  });

  test("returns an empty list for missing and empty input", () => {
    expect(parseReferences(undefined)).toEqual([]);
    expect(parseReferences(null)).toEqual([]);
    expect(parseReferences("")).toEqual([]);
    expect(parseReferences("   ")).toEqual([]);
  });
});

describe("parentCandidates", () => {
  test("asks In-Reply-To first, because it names exactly one message", () => {
    const candidates = parentCandidates("direct@example.com", ["root@example.com"]);
    expect(candidates[0]).toBe("direct@example.com");
  });

  test("reads References newest-ancestor first, and that ordering is the whole point", () => {
    // `References` is oldest-first, so it must be walked backwards. A caller resolves the first id it
    // recognizes and stops — read forwards, every reply in a long thread would attach to the root
    // message instead of to the one it answers, and the conversation would render as a flat fan-out.
    expect(parentCandidates(undefined, ["root@example.com", "mid@example.com", "near@example.com"])).toEqual([
      "near@example.com",
      "mid@example.com",
      "root@example.com",
    ]);
  });

  test("puts In-Reply-To ahead of the reversed chain, most precise to least", () => {
    expect(parentCandidates("direct@example.com", ["root@example.com", "near@example.com"])).toEqual([
      "direct@example.com",
      "near@example.com",
      "root@example.com",
    ]);
  });

  test("deduplicates without losing the In-Reply-To priority", () => {
    // In-Reply-To is normally the last `References` entry too; it must stay at the front, not be
    // swallowed by the copy that appears later in the reversed chain.
    expect(parentCandidates("near@example.com", ["root@example.com", "near@example.com"])).toEqual([
      "near@example.com",
      "root@example.com",
    ]);
  });

  test("does not mutate the References array it was handed", () => {
    // `reverse()` is in place; reversing the caller's stored chain would corrupt the row it came from.
    const references = ["root@example.com", "near@example.com"];
    parentCandidates(undefined, references);
    expect(references).toEqual(["root@example.com", "near@example.com"]);
  });

  test("returns nothing when there is neither header — a new thread, not a broken one", () => {
    expect(parentCandidates(undefined, [])).toEqual([]);
  });
});

describe("buildReferencesHeader", () => {
  test("appends the parent's own Message-ID, per RFC 5322 §3.6.4", () => {
    // The parent's id belongs at the end of the chain. Omit it and the customer's client sees a new
    // mail for every answer — the single most visible way a support inbox looks broken.
    expect(buildReferencesHeader(["root@example.com", "mid@example.com"], "parent@example.com")).toBe(
      "<root@example.com> <mid@example.com> <parent@example.com>",
    );
  });

  test("brackets and space-separates, ready to be a header value", () => {
    expect(buildReferencesHeader([], "parent@example.com")).toBe("<parent@example.com>");
  });

  test("omits the parent id when there is not one, rather than emitting an empty pair", () => {
    expect(buildReferencesHeader(["root@example.com"])).toBe("<root@example.com>");
    expect(buildReferencesHeader([])).toBe("");
  });

  test("deduplicates, so a client that already listed the parent does not get it twice", () => {
    const header = buildReferencesHeader(["root@example.com", "parent@example.com"], "parent@example.com");
    expect(header).toBe("<root@example.com> <parent@example.com>");
  });

  test("trims from the front when the chain is over the cap — the oldest go, never the newest", () => {
    // RFC 5322 says drop the oldest: the recent entries are what a receiving client threads on, so
    // trimming from the back would sever the reply from the message it answers.
    const header = buildReferencesHeader(chain(MAX_REFERENCES + 10), "parent@example.com");
    const ids = header.split(" ");
    // Eleven over the cap once the parent id is appended, so `id-0` through `id-10` are the ones cut.
    expect(ids).toHaveLength(MAX_REFERENCES);
    expect(header).not.toContain("<id-0@example.com>");
    expect(header).not.toContain("<id-10@example.com>");
    expect(ids[0]).toBe("<id-11@example.com>");
    expect(ids.at(-1)).toBe("<parent@example.com>");
  });

  test("does not mutate the parent's stored chain", () => {
    const references = ["root@example.com"];
    buildReferencesHeader(references, "parent@example.com");
    expect(references).toEqual(["root@example.com"]);
  });
});

describe("mintMessageId", () => {
  test("takes the domain from the address the reply is sent as", () => {
    // A receiving spam filter reads the domain half; pointing it at a domain we do not control is a
    // deliverability problem, not a cosmetic one.
    expect(mintMessageId("support@example.com", "0d6f")).toBe("0d6f@example.com");
  });

  test("uses the last @ so a subaddressed sender still yields its real domain", () => {
    expect(mintMessageId("support+tickets@mail.example.com", "0d6f")).toBe("0d6f@mail.example.com");
  });

  test("falls back to localhost rather than minting a domainless id", () => {
    // An id with no domain is not a Message-ID, and the customer's `In-Reply-To` would carry it back.
    expect(mintMessageId("", "0d6f")).toBe("0d6f@localhost");
  });

  test("round-trips through normalizeMessageId, which is how the reply comes back", () => {
    const minted = mintMessageId("support@example.com", "0d6f");
    expect(normalizeMessageId(`<${minted}>`)).toBe(minted);
  });
});

describe("replySubject", () => {
  test("prefixes a fresh subject", () => {
    expect(replySubject("Refund please")).toBe("Re: Refund please");
  });

  test("prefixes exactly once — answering a long thread never builds `Re: Re: Re:`", () => {
    expect(replySubject("Re: Refund please")).toBe("Re: Refund please");
    expect(replySubject(replySubject(replySubject("Refund please")))).toBe("Re: Refund please");
  });

  test("matches the prefix case-insensitively", () => {
    expect(replySubject("RE: Refund please")).toBe("RE: Refund please");
    expect(replySubject("re: refund please")).toBe("re: refund please");
  });

  test("tolerates the bracketed count some clients add", () => {
    expect(replySubject("Re[2]: Refund please")).toBe("Re[2]: Refund please");
    expect(replySubject("RE[12]: Refund please")).toBe("RE[12]: Refund please");
  });

  test("leaves a non-English prefix alone, deliberately", () => {
    // Non-English prefixes are unbounded in practice. A stray `Re: Aw:` is cosmetic; stripping a word
    // that merely looked like a prefix would change what the customer wrote.
    expect(replySubject("Aw: Rückerstattung")).toBe("Re: Aw: Rückerstattung");
    expect(replySubject("Antw: Refund")).toBe("Re: Antw: Refund");
  });

  test("needs the colon — a subject that merely starts with `re` is not a reply", () => {
    // Anchoring on `re` alone would swallow every subject beginning with `Reminder` or `Reset`.
    expect(replySubject("Reminder about my refund")).toBe("Re: Reminder about my refund");
    expect(replySubject("Reset my password")).toBe("Re: Reset my password");
  });

  test("trims before deciding, so a leading space does not double the prefix", () => {
    expect(replySubject("  Re: Refund please  ")).toBe("Re: Refund please");
  });
});
