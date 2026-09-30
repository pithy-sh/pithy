// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { devLoginIdentities } from "./devLogin";

/**
 * `docs/commands/dev.md` pastes the `pithy dev --json` session line, and a script is written against what
 * it pastes. The page spent one release saying the line carries **no** dev-login field, which was true and
 * is not: `#667` puts the seeded identities on it, because that is the surface an agent selects against.
 *
 * Two properties, and the second is the one that matters. The sample must be the shape the CLI emits — a
 * documented key nothing writes is a script that reads `undefined`. And **the sample must carry no claim**,
 * because a page is where somebody copies from: a claim pasted into the docs is a credential-shaped example
 * that teaches the wrong thing even when the code is right.
 *
 * `readyWatchDocs.test.ts` is the same pattern on the same page, for the same reason CLAUDE.md gives — an
 * adopter-facing shape cannot drift from the code.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PAGE = readFileSync(join(REPO_ROOT, "docs", "commands", "dev.md"), "utf8");
const WHERE = "docs/commands/dev.md";

/** The session-line sample the page pastes: the `pithy dev` object that carries `workers`. */
function sessionLine(): Record<string, unknown> {
  const sample = /```json\n(\{"command":"dev","workers".*)\n```/.exec(PAGE)?.[1];
  if (sample === undefined) throw new Error(`${WHERE} no longer pastes a session line. Repin or restore it.`);
  return JSON.parse(sample) as Record<string, unknown>;
}

describe("the documented session line", () => {
  test("carries an `identities` array beside `workers`", () => {
    expect(Array.isArray(sessionLine().identities)).toBe(true);
  });

  test("names each identity with exactly the keys the CLI projects", () => {
    // Against `devLoginIdentities` rather than a second copy of the key list, so a field added to the
    // projection fails here until the page documents it.
    const projected = devLoginIdentities(
      {
        "example-ada": {
          email: "ada@example.com",
          userId: "example-ada",
          claim: "a-claim",
          expiresAt: new Date("2027-07-27T00:00:00.000Z"),
        },
      },
      new Date("2026-08-06T00:00:00.000Z"),
    );
    const documented = sessionLine().identities as Record<string, unknown>[];
    expect(documented.length).toBeGreaterThan(0);
    for (const identity of documented) {
      expect(Object.keys(identity).sort()).toEqual(Object.keys(projected[0] ?? {}).sort());
    }
  });

  test("**pastes no claim, and documents that the line never carries one**", () => {
    for (const identity of sessionLine().identities as Record<string, unknown>[]) {
      expect(identity).not.toHaveProperty("claim");
    }
    expect(PAGE).toContain("no `claim`");
  });
});
