// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { COMMAND_REGISTRY } from "../main";
import { HELP_GROUP_ORDER } from "./groups";

/**
 * What is left to check once the grouping is a type (#407).
 *
 * The obvious gate here would be *every command is in exactly one group* — and it is not written, because
 * it cannot fail. `main.ts` declares one record with a required `group` typed as {@link HELP_GROUP_ORDER}'s
 * union, so a command with no group and a command with a misspelled group are both compile errors, and
 * `subCommands` is projected from that same record rather than written beside it. There is no second list
 * to drift and no ungrouped state to catch. A test asserting it would be `ci/sweepPopulation.test.ts`'s
 * shape 3: a check derived from its own subject, green by construction.
 *
 * The projection is not asserted either, for the same reason: `COMMAND_REGISTRY` *is* the record
 * `subCommands` is built from, so comparing their key lists compares a list to itself. What that check
 * was reaching for — a name citty dispatches that never reaches the screen — is asserted where it can
 * actually fail, against the rendered output, in `rootUsage.test.ts`.
 *
 * One thing the compiler does not say, so it is here.
 */

describe("the command registry", () => {
  test("every declared group has at least one command", () => {
    // A group with no members renders no heading, so this is not a crash — it is a dead entry in the
    // order list, which is the kind of thing that survives for a year because nothing looks wrong.
    for (const group of HELP_GROUP_ORDER) {
      const members = Object.values(COMMAND_REGISTRY).filter((entry) => entry.group === group);
      expect(members.length, `${group} has no commands`).toBeGreaterThan(0);
    }
  });
});
