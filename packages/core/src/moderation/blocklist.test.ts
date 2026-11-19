// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { blocklistModerator } from "./blocklist";
import type { ModerationVerdict } from "./moderator";
import { SHIPPED_BLOCKLIST } from "./shippedList";

const REJECT: ModerationVerdict = { verdict: "reject", reason: "blocklist" };
const ALLOW: ModerationVerdict = { verdict: "allow" };

describe("blocklistModerator over the shipped list", () => {
  const moderator = blocklistModerator({ words: SHIPPED_BLOCKLIST });

  test.each([
    ["shit"],
    ["SHIT"],
    ["ｓｈｉｔ"],
    ["$h1t"],
    ["5HlT"],
    ["sh​it"],
    ["ѕhіt"],
    ["ѕһіt"],
    ["ᴄᴜɴᴛ"],
    ["ΝIGGER"],
    ["Νigger"],
    ["s h 1 t"],
    ["s h i t"],
    ["s.h.i.t"],
    ["BigShit"],
    ["big_shit_energy"],
    ["what the shit."],
  ])("rejects %j", async (text) => {
    expect(await moderator.check(text, "handle")).toEqual(REJECT);
  });

  test.each([
    ["as hit"],
    ["grass"],
    ["class act"],
    ["Scunthorpe United"],
    ["The title screen"],
    ["Analysis of a cave"],
    ["Cocktail hour"],
    ["Pass it on"],
    ["Level 455"],
    ["Route 455"],
    ["Boeing 717"],
    ["4 5 5"],
    ["dave717"],
    [""],
  ])("allows %j", async (text) => {
    expect(await moderator.check(text, "title")).toEqual(ALLOW);
  });

  test("a starred entry rejects every word that starts with it", async () => {
    expect(await moderator.check("fucking great", "free_text")).toEqual(REJECT);
    expect(await moderator.check("shitty level", "title")).toEqual(REJECT);
  });

  test("a phrase entry rejects its words in order, and run together", async () => {
    expect(await moderator.check("jerk off", "free_text")).toEqual(REJECT);
    expect(await moderator.check("JerkOff99", "handle")).toEqual(REJECT);
    expect(await moderator.check("off jerk", "free_text")).toEqual(ALLOW);
  });
});

describe("blocklistModerator over a list of its own", () => {
  const moderator = blocklistModerator({ words: ["crate", "big box", "lid*"] });

  test("rejects a listed word and allows its letters split across words", async () => {
    expect(await moderator.check("A CRATE", "title")).toEqual(REJECT);
    expect(await moderator.check("cr ate", "title")).toEqual(ALLOW);
    expect(await moderator.check("sac rated", "title")).toEqual(ALLOW);
    expect(await moderator.check("crates", "title")).toEqual(ALLOW);
  });

  test("matches a phrase across the separators between its words", async () => {
    expect(await moderator.check("the big-box store", "title")).toEqual(REJECT);
    expect(await moderator.check("big red box", "title")).toEqual(ALLOW);
  });

  test("matches a starred entry as a prefix only", async () => {
    expect(await moderator.check("lidded", "title")).toEqual(REJECT);
    expect(await moderator.check("valid", "title")).toEqual(ALLOW);
  });

  test("an empty list allows everything", async () => {
    expect(await blocklistModerator({ words: [] }).check("crate", "handle")).toEqual(ALLOW);
  });
});

describe("SHIPPED_BLOCKLIST", () => {
  test("every entry still has a word after folding, and none is listed twice", () => {
    const moderator = blocklistModerator({ words: SHIPPED_BLOCKLIST });
    expect(moderator).toBeDefined();
    expect(new Set(SHIPPED_BLOCKLIST).size).toBe(SHIPPED_BLOCKLIST.length);
    expect(SHIPPED_BLOCKLIST.length).toBeGreaterThan(50);
  });

  test("every entry rejects itself", async () => {
    const moderator = blocklistModerator({ words: SHIPPED_BLOCKLIST });
    for (const entry of SHIPPED_BLOCKLIST) {
      expect(await moderator.check(entry.replace(/\*$/, ""), "handle"), entry).toEqual(REJECT);
    }
  });
});
