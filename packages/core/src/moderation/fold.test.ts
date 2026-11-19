// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { foldEntry, wordSequences } from "./fold";

describe("wordSequences", () => {
  test("splits on anything that is not a letter or a digit", () => {
    expect(wordSequences("Level one: the-cave!")).toContainEqual(["ievei", "one", "the", "cave"]);
  });

  test("folds case and width into the same word", () => {
    const plain = wordSequences("crate")[0];
    expect(wordSequences("CRATE")[0]).toEqual(plain);
    expect(wordSequences("ｃｒａｔｅ")[0]).toEqual(plain);
    expect(wordSequences("𝐜𝐫𝐚𝐭𝐞")[0]).toEqual(plain);
  });

  test("drops accents and the combining marks stacked on a letter", () => {
    expect(wordSequences("crâté")[0]).toEqual(wordSequences("crate")[0]);
    expect(wordSequences("c̶r̶a̶t̶e")[0]).toEqual(wordSequences("crate")[0]);
  });

  test("folds Cyrillic and Greek look-alikes onto the Latin letter they imitate", () => {
    // Cyrillic с, а, р, е; Greek τ, ο.
    expect(wordSequences("саре")[0]).toEqual(wordSequences("cape")[0]);
    expect(wordSequences("τοp")[0]).toEqual(wordSequences("top")[0]);
  });

  test("folds digits and symbols used as letters", () => {
    expect(wordSequences("cr4t3")[0]).toEqual(wordSequences("crate")[0]);
    expect(wordSequences("$p0t")[0]).toEqual(wordSequences("spot")[0]);
    expect(wordSequences("@corn")[0]).toEqual(wordSequences("acorn")[0]);
  });

  test("treats l, I and 1 as one letter, so a swap between them is no disguise", () => {
    const expected = wordSequences("slot")[0];
    expect(wordSequences("s1ot")[0]).toEqual(expected);
    expect(wordSequences("sIot")[0]).toEqual(expected);
  });

  test("removes invisible characters inside a word instead of splitting on them", () => {
    expect(wordSequences("cr​ate")[0]).toEqual(wordSequences("crate")[0]);
    expect(wordSequences("cr­ate")[0]).toEqual(wordSequences("crate")[0]);
  });

  test("also reads a camel-cased name as the words it is made of", () => {
    expect(wordSequences("BigCrate")).toContainEqual(["big", "crate"]);
    expect(wordSequences("BigCrate")).toContainEqual(["bigcrate"]);
  });

  test("also reads digits at either end of a name as a word of their own", () => {
    expect(wordSequences("crate99")).toContainEqual(["crate", "99"]);
    expect(wordSequences("2crate")).toContainEqual(["2", "crate"]);
    // A digit inside a word stays a letter, and gives no second reading.
    expect(wordSequences("cr4te")).toEqual([["crate"]]);
  });

  test("leaves a word made only of digits as a number", () => {
    expect(wordSequences("Level 455")).toEqual([["ievei", "455"]]);
    expect(wordSequences("dave717")).toContainEqual(["dave", "717"]);
    expect(wordSequences("4 5 5")).toContainEqual(["455"]);
    // Next to a letter, a digit still reads as one.
    expect(wordSequences("dave717")).toContainEqual(["davetit"]);
  });

  test("folds a capital by its own shape before folding its case", () => {
    // Greek Ν, Μ, Η, Υ look like N, M, H, Y, though their lowercase forms look like v, u, n, u.
    expect(wordSequences("ΝΜΗΥ")[0]).toEqual(wordSequences("nmhy")[0]);
    // Cyrillic С, Н, Т, У.
    expect(wordSequences("СНТУ")[0]).toEqual(wordSequences("chty")[0]);
  });

  test("folds Latin small capitals and Cyrillic һ", () => {
    expect(wordSequences("ᴄʀᴀᴛᴇ")[0]).toEqual(wordSequences("crate")[0]);
    expect(wordSequences("ᴀʙᴅꜰɢʜɪᴊᴋᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ")[0]).toEqual(wordSequences("abdfghijkmnoprstuvwyz")[0]);
    expect(wordSequences("һ")[0]).toEqual(["h"]);
  });

  test("also reads letters spelled out one at a time as one word", () => {
    expect(wordSequences("c r a t e")).toContainEqual(["crate"]);
    expect(wordSequences("my c.r.a.t.e box")).toContainEqual(["my", "crate", "box"]);
    expect(wordSequences("c r 4 t e")).toContainEqual(["crate"]);
  });

  test("an empty or symbol-only text has no words", () => {
    expect(wordSequences("")).toEqual([[]]);
    expect(wordSequences(" -- ")).toEqual([[]]);
  });
});

describe("foldEntry", () => {
  test("folds a list word the same way as the text it is checked against", () => {
    expect(foldEntry("CRÂTE")).toEqual({ words: ["crate"], prefix: false });
  });

  test("a trailing star makes the last word match anything that starts with it", () => {
    expect(foldEntry("crate*")).toEqual({ words: ["crate"], prefix: true });
  });

  test("keeps the words of a phrase in order", () => {
    expect(foldEntry("Big crate")).toEqual({ words: ["big", "crate"], prefix: false });
  });

  test("an entry with nothing left after folding has no words", () => {
    expect(foldEntry("--").words).toEqual([]);
  });
});
