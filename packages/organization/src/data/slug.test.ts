// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { MAX_SLUG_LENGTH, Organization } from "./organization";
import { deriveSlug, suffixSlug } from "./slug";

/**
 * Deriving a short name from a display name, and the one property that has to hold for all of them.
 *
 * **The interesting half is not `Acme Games` → `acme-games`.** It is every name that is not English:
 * the dashboard generated slugs in the browser with `name.toLowerCase().replace(/[^a-z0-9]+/g, "-")`,
 * which reduces every Chinese, Russian, Greek, Arabic, Hebrew and Thai name in the world to the same
 * empty string. A shared base is a base somebody can exhaust, and the account that cannot be founded is
 * the one whose name is not written in Latin script.
 *
 * So the gate below is a sweep rather than a list of examples, and its reach is the rule it protects:
 * **whatever a person types, the derived slug satisfies the column.** A name that reduces to nothing is
 * inside that reach, not outside it.
 */

/** Does the column itself accept this? The one arbiter — never a second regular expression here. */
function accepted(slug: string): boolean {
  return Organization.shape.slug.safeParse(slug).success;
}

describe("deriving a slug from a name", () => {
  test("a name written in Latin script reads as itself", () => {
    expect(deriveSlug("Acme Games")).toBe("acme-games");
    expect(deriveSlug("  Northside   Athletic  ")).toBe("northside-athletic");
    expect(deriveSlug("acme-games")).toBe("acme-games");
  });

  test("an apostrophe closes rather than splits, and every other mark is a single hyphen", () => {
    // `Cai's Studio` is one word plus one word. Hyphenating the apostrophe would say it is three, and
    // `cai-s-studio` is what the dashboard's browser-side version produced.
    expect(deriveSlug("Cai's Studio")).toBe("cais-studio");
    expect(deriveSlug("Cai’s Studio")).toBe("cais-studio");
    expect(deriveSlug("Acme, Inc. // Games!!")).toBe("acme-inc-games");
  });

  test("accents fold to the letters underneath them", () => {
    expect(deriveSlug("Café Ñandú")).toBe("cafe-nandu");
    expect(deriveSlug("Ærø Sørensen")).toBe("aero-sorensen");
  });

  test("a compatibility form that decomposes to capitals keeps its letters", () => {
    // Decomposition runs before the lowercasing for exactly this: `㎒` is `MHz`, and the other order
    // throws the `MH` away as punctuation and leaves `z`.
    expect(deriveSlug("Acme ㎒")).toBe("acme-mhz");
    expect(deriveSlug("ＡＣＭＥ")).toBe("acme");
    expect(deriveSlug("Ⅻ Studio")).toBe("xii-studio");
  });

  test("a long name is bounded, and never ends on a hyphen", () => {
    const derived = deriveSlug(`${"Northside Athletic Association ".repeat(20)}`);
    expect(derived.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(accepted(derived)).toBe(true);
  });

  test("a name that reduces to nothing still yields a slug somebody can use", () => {
    // The refusal nobody can act on: *pick a valid short name* addressed to a person who never typed
    // one. Every one of these is a name a person may genuinely have.
    for (const name of ["!!!", "…", "株式会社", "Привет", "Ωμέγα", "شركة", "חברה", "บริษัท", "🙂"]) {
      expect(accepted(deriveSlug(name)), name).toBe(true);
    }
  });

  test("names in one script do not share one base", () => {
    // The defect this exists for. Collapsing to a shared base makes the retry suffix the whole of the
    // distinction, and a base anybody can exhaust is a base an attacker can exhaust.
    const names = [
      "株式会社",
      "有限会社",
      "京都",
      "東京",
      "Привет",
      "Москва",
      "Ωμέγα",
      "Αθήνα",
      "شركة",
      "مؤسسة",
      "חברה",
      "עמותה",
      "บริษัท",
      "ห้างหุ้นส่วน",
    ];
    const derived = names.map((name) => deriveSlug(name));
    expect(new Set(derived).size).toBe(names.length);
  });

  test("a name that is partly Latin keeps the part that is", () => {
    expect(deriveSlug("Acme 株式会社")).toBe("acme");
    expect(deriveSlug("Москва Games")).toBe("games");
  });

  test("the same name always derives the same slug", () => {
    // Derivation is not allowed to be random: a suffix is what distinguishes two accounts, and a base
    // that moved between two calls would make the retry loop's first attempt meaningless.
    for (const name of ["Acme Games", "株式会社", "!!!"]) {
      expect(deriveSlug(name), name).toBe(deriveSlug(name));
    }
  });

  /**
   * The gate. Its reach is the rule: **every name, without exception, derives to a slug the column
   * accepts.**
   *
   * Examples prove the cases somebody thought of. This sweeps the code space instead — every third
   * code point from the ASCII space up through the BMP, each as a short name, plus the strings that
   * have historically broken a slugifier: lone combining marks, bidirectional controls, zero-width
   * joiners, a lone surrogate, and the empty string.
   *
   * **And every place the bound can fall.** The first version of this test swept 21,000 names and
   * still passed with the truncation's trailing hyphen left on, because not one of those names had a
   * word break at exactly the cut. A gate whose reach is smaller than its rule is a gate that reports
   * what it happened to look at, so the last loop walks the break across the boundary deliberately.
   */
  test("every name there is derives to a slug the column accepts", () => {
    const names: string[] = [
      "",
      " ",
      "-",
      "---",
      "\u0301",
      "\u200d",
      "\u200b",
      "\u202e",
      "\ud800",
      "\u0000",
      "\n\t",
      "a".repeat(1000),
      "-".repeat(1000),
      "🇯🇵🇬🇧",
      "ＡＣＭＥ",
      "Ⅻ",
      "①②③",
    ];
    for (let point = 0x20; point <= 0xffff; point += 3) {
      names.push(String.fromCodePoint(point).repeat(3));
    }
    for (let point = 0x10000; point <= 0x1ffff; point += 97) {
      names.push(String.fromCodePoint(point));
    }
    for (let head = 0; head <= MAX_SLUG_LENGTH + 4; head += 1) {
      names.push(`${"x".repeat(head)} ${"y".repeat(MAX_SLUG_LENGTH * 2)}`);
      names.push(`${"x".repeat(head)} ${"y".repeat(MAX_SLUG_LENGTH * 2)} z`);
    }

    const refused = names.filter((name) => !accepted(deriveSlug(name)));
    expect(refused.map((name) => JSON.stringify(name)).slice(0, 20)).toEqual([]);
    // Anti-vacuity: a sweep that walked nothing refuses nothing, and refusing nothing is what passing
    // looks like.
    expect(names.length).toBeGreaterThan(20000);
  });
});

describe("suffixing a slug that is taken", () => {
  test("the suffix survives, the base gives way, and the result still fits", () => {
    expect(suffixSlug("acme-games", "7f3a")).toBe("acme-games-7f3a");
    const long = suffixSlug("a".repeat(MAX_SLUG_LENGTH), "7f3a");
    expect(long.endsWith("-7f3a")).toBe(true);
    expect(long.length).toBe(MAX_SLUG_LENGTH);
    expect(accepted(long)).toBe(true);
  });

  test("a base that gives way entirely leaves the suffix rather than a leading hyphen", () => {
    // `-7f3a` is not a slug. The base is what may be sacrificed; the suffix is what makes the row land.
    expect(accepted(suffixSlug("ab", "7f3a".repeat(20)))).toBe(true);
  });

  test("a base truncated onto a hyphen does not keep it", () => {
    expect(suffixSlug(`${"a".repeat(58)}-bcdefg`, "xy")).toBe(`${"a".repeat(58)}-bc-xy`);
    expect(suffixSlug(`${"a".repeat(60)}-bcdefg`, "xy")).toBe(`${"a".repeat(60)}-xy`);
  });
});
