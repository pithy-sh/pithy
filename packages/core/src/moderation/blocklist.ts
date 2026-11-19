// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type FoldedEntry, foldEntry, wordSequences } from "./fold";
import type { TextModerator } from "./moderator";

/** Does `entry` match the words of `words` starting at `start`? */
function matchesAt(words: readonly string[], start: number, entry: FoldedEntry): boolean {
  const last = entry.words.length - 1;
  if (start + last >= words.length) return false;
  for (let i = 0; i <= last; i++) {
    const word = words[start + i] ?? "";
    const want = entry.words[i] ?? "";
    const matched = i === last && entry.prefix ? word.startsWith(want) : word === want;
    if (!matched) return false;
  }
  return true;
}

/**
 * Every entry `words` holds, folded, plus each phrase entry's words run together as one, so `jerk off` also
 * matches `jerkoff`.
 */
function foldList(words: readonly string[]): FoldedEntry[] {
  const entries: FoldedEntry[] = [];
  for (const word of words) {
    const entry = foldEntry(word);
    if (entry.words.length === 0) continue;
    entries.push(entry);
    if (entry.words.length > 1) entries.push({ words: [entry.words.join("")], prefix: entry.prefix });
  }
  return entries;
}

/**
 * A moderator that rejects text holding any word on `words`, and allows everything else.
 *
 * Both the text and the list are folded first: case, width, accents, invisible characters, and characters that
 * stand in for a letter (`$h1t`, a Cyrillic `ѕ`). Matching is by whole word, so a listed word inside a longer
 * one, or its letters split across two words, is allowed. An entry ending in `*` matches every word that
 * starts with it, and an entry of several words matches them in order, or run together.
 *
 * It answers only `allow` or `reject`, whatever the context. `review` is for a classifier that can be unsure,
 * and for the seam when a moderator fails.
 */
export function blocklistModerator(options: { readonly words: readonly string[] }): TextModerator {
  const entries = foldList(options.words);
  return {
    async check(text) {
      for (const words of wordSequences(text)) {
        for (let start = 0; start < words.length; start++) {
          if (entries.some((entry) => matchesAt(words, start, entry)))
            return { verdict: "reject", reason: "blocklist" };
        }
      }
      return { verdict: "allow" };
    },
  };
}
