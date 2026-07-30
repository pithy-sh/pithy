// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The licences this repo declares, and the only ones the gate can generate a `LICENSE` for.
 *
 * A package declaring anything else fails the check rather than silently shipping no licence text:
 * adding a licence is a deliberate act, so it should cost one `.txt` file and one entry here.
 */
export const KNOWN_LICENSES = ["MIT", "FSL-1.1-MIT"] as const;

/**
 * The verbatim text of a licence, or `null` if we hold none for it.
 *
 * The texts live as inert `.txt` files rather than TypeScript constants on purpose. Legal text has
 * to stay byte-exact, and a `.ts` file is subject to the formatter — a reflowed paragraph in a
 * licence is a change nobody reviewed.
 */
export function canonicalText(license: string): string | null {
  if (!isKnown(license)) return null;
  const path = fileURLToPath(new URL(`../licenses/${license}.txt`, import.meta.url));
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/**
 * Is this one of the ids we hold text for?
 *
 * The allowlist runs before the id ever becomes a path. A `license` field is a string read off a
 * file, and interpolating it into a URL unchecked lets `../` walk out of `licenses/` — checking
 * membership first means the id is never a path expression at all.
 */
export function isKnown(license: string): license is (typeof KNOWN_LICENSES)[number] {
  return (KNOWN_LICENSES as readonly string[]).includes(license);
}
