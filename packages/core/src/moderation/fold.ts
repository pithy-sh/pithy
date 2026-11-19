// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Capital letters folded onto the Latin letter they look like, applied before case folding.
 *
 * A capital can look like a different letter from its own lowercase form: Greek `Ν` looks like `N` while `ν`
 * looks like `v`. Folding capitals by their own shape first keeps `ΝAME` and `NAME` one word.
 */
const CAPITAL_LOOK_ALIKES: Readonly<Record<string, string>> = {
  // Greek.
  Α: "a",
  Β: "b",
  Ε: "e",
  Ζ: "z",
  Η: "h",
  Ι: "i",
  Κ: "k",
  Μ: "m",
  Ν: "n",
  Ο: "o",
  Ρ: "p",
  Τ: "t",
  Υ: "y",
  Χ: "x",
  // Cyrillic.
  А: "a",
  В: "b",
  Е: "e",
  К: "k",
  М: "m",
  Н: "h",
  О: "o",
  Р: "p",
  С: "c",
  Т: "t",
  У: "y",
  Х: "x",
  Ь: "b",
  Ѕ: "s",
  І: "i",
  Ӏ: "i",
  Ј: "j",
  Һ: "h",
  Ԁ: "d",
  Ԛ: "q",
  Ԝ: "w",
};

/**
 * Characters folded onto the letter they stand in for, applied after case folding and accent stripping.
 *
 * Both sides of a comparison go through it, so `l`, `I` and `1` all become `i`: a word written with any of
 * them matches a list entry written with any other. The fold is for matching only and is never shown.
 */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  // Digits and symbols written as letters. A word of digits alone is a number, and is not folded.
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
  // Latin letters that read as another.
  l: "i",
  ı: "i",
  ł: "i",
  ø: "o",
  đ: "d",
  ð: "d",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  // Latin small capitals, as fancy-text generators write them.
  ᴀ: "a",
  ʙ: "b",
  ᴄ: "c",
  ᴅ: "d",
  ᴇ: "e",
  ꜰ: "f",
  ɢ: "g",
  ʜ: "h",
  ɪ: "i",
  ᴊ: "j",
  ᴋ: "k",
  ʟ: "i",
  ᴍ: "m",
  ɴ: "n",
  ᴏ: "o",
  ᴘ: "p",
  ꞯ: "q",
  ʀ: "r",
  ꜱ: "s",
  ᴛ: "t",
  ᴜ: "u",
  ᴠ: "v",
  ᴡ: "w",
  ʏ: "y",
  ᴢ: "z",
  // Cyrillic.
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  ь: "b",
  һ: "h",
  і: "i",
  ӏ: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  // Greek.
  α: "a",
  β: "b",
  γ: "y",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  μ: "u",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ω: "w",
  // IPA and other Latin extensions.
  ɡ: "g",
  ɑ: "a",
};

/** A character that splits words: anything but a letter, a digit, or a symbol {@link LOOK_ALIKES} reads as a letter. */
const SEPARATOR = /[^\p{L}\p{N}@$]+/u;

/** Characters that render as nothing, and are removed rather than read as a break between words. */
const INVISIBLE = /\p{Cf}/gu;

/** A word made only of digits: a number, which stays a number rather than being read as letters. */
const NUMBER = /^\p{N}+$/u;

/** `text` with width and compatibility forms folded, invisible characters removed, and accents stripped. */
function bareText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "").normalize("NFD").replace(/\p{M}/gu, "");
}

/** One word with capital look-alikes, case and look-alike characters folded. A number is left as it is. */
function foldWord(word: string): string {
  if (NUMBER.test(word)) return word;
  let capitals = "";
  for (const char of word) capitals += CAPITAL_LOOK_ALIKES[char] ?? char;
  let folded = "";
  for (const char of capitals.toLowerCase()) folded += LOOK_ALIKES[char] ?? char;
  return folded;
}

/** The folded words of `bare`, text already passed through {@link bareText}, in order. */
function wordsOf(bare: string): string[] {
  return bare
    .split(SEPARATOR)
    .filter((word) => word.length > 0)
    .map(foldWord);
}

/**
 * `words` with every run of two or more one-character words joined into one word, folded again so a digit in
 * a run that has a letter in it reads as a letter.
 */
function joinSpelledOut(words: readonly string[]): string[] {
  const joined: string[] = [];
  let run = "";
  const flush = (): void => {
    if (run.length > 0) joined.push(foldWord(run));
    run = "";
  };
  for (const word of words) {
    if (word.length === 1) run += word;
    else {
      flush();
      joined.push(word);
    }
  }
  flush();
  return joined;
}

/**
 * Every reading of `text` as a sequence of folded words.
 *
 * The first is the plain reading: width and compatibility forms folded by NFKC, invisible characters and
 * accents removed, the result split at anything that is not a letter or a digit, and each word's case and
 * look-alike characters folded. A word made only of digits is a number and stays one, so `Level 455` is not
 * read as letters: a digit stands in for a letter only in a word that has a letter in it. The others read a
 * name as its parts (`BigCrate` as `big crate`, `crate99` as `crate 99`) and a word spelled out one character
 * at a time as one word (`c r a t e`, `c.r.4.t.e`). A checker rejects when any reading matches.
 */
export function wordSequences(text: string): string[][] {
  const bare = bareText(text);
  const plain = wordsOf(bare);
  const parts = wordsOf(
    bare
      .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
      .replace(/(\p{L})(\p{N}+)(?![\p{L}\p{N}])/gu, "$1 $2")
      .replace(/(?<![\p{L}\p{N}])(\p{N}+)(\p{L})/gu, "$1 $2"),
  );
  const readings = [plain, parts, joinSpelledOut(plain)];
  const seen = new Set<string>();
  return readings.filter((words) => {
    const key = words.join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One blocklist entry, folded for matching. */
export interface FoldedEntry {
  /** The entry's folded words, in order. Empty when nothing was left after folding. */
  readonly words: readonly string[];
  /** Whether the last word matches any word that starts with it, which a trailing `*` asks for. */
  readonly prefix: boolean;
}

/** A blocklist entry folded the same way {@link wordSequences} folds the text it is checked against. */
export function foldEntry(entry: string): FoldedEntry {
  const trimmed = entry.trim();
  const prefix = trimmed.endsWith("*");
  const body = prefix ? trimmed.slice(0, -1) : trimmed;
  return { words: wordsOf(bareText(body)), prefix };
}
