// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { GroupPosition } from "@pithy-sh/core/src/migrations/groups";
import { isDownRefusal } from "@pithy-sh/core/src/migrations/retained";
import { describe, expect, test } from "vitest";
import {
  appliedLabel,
  buriedGroupRefusal,
  missingDownRefusal,
  noGroupRefusal,
  requireMigrationGroup,
  sharedGroupRefusal,
  unknownGroupRefusal,
} from "./groups";

const APPLIED = new Date("2026-10-03T19:52:47.611Z");

/** A group that is the top of its database's chain — the one position that can be reversed. */
const onTop = (migrations: string[]): GroupPosition => ({ state: "top", migrations: [...migrations].reverse() });

/** What `body` threw, as a `PithyError` — or a failed assertion when it returned. */
function refusalOf(body: () => unknown): PithyError {
  try {
    body();
  } catch (error) {
    expect(error).toBeInstanceOf(PithyError);
    return error as PithyError;
  }
  throw new Error("expected a refusal");
}

describe("appliedLabel", () => {
  test("names the minute, in UTC, because that is what an operator reads it against", () => {
    expect(appliedLabel(APPLIED)).toBe("2026-10-03 19:52 UTC");
  });
});

describe("requireMigrationGroup", () => {
  test("hands a named group back, trimmed, so a retry extends the group it is retrying", () => {
    expect(requireMigrationGroup("release-7")).toBe("release-7");
    expect(requireMigrationGroup("  release-7\n")).toBe("release-7");
  });

  test("no group is no group — the run stamps itself", () => {
    expect(requireMigrationGroup(undefined)).toBeUndefined();
  });

  test('a blank group is refused: it is `--group "$RELEASE"` with the variable unset', () => {
    // Recorded, it would collect every run that made the same mistake into one group — the silent merge
    // of unrelated runs that a per-run timestamp exists to prevent.
    const refusal = refusalOf(() => requireMigrationGroup("   "));
    expect(refusal.payload.message).toBe("--group takes a value.");
    expect(refusal.payload.action).toBe(
      "Name the group this run belongs to, or leave --group off and let the run stamp itself.",
    );
    expect(refusalOf(() => requireMigrationGroup("")).payload.message).toBe("--group takes a value.");
  });
});

describe("noGroupRefusal", () => {
  test("names the newest group, what it holds per database, and the command that reverses it", () => {
    const refusal = noGroupRefusal([
      {
        binding: "DB",
        group: { group: "2026-10-03T19:52:47.611Z", appliedAt: APPLIED, migrations: ["2000_app_0003_release_notes"] },
        position: onTop(["2000_app_0003_release_notes"]),
      },
      {
        binding: "EMAIL_SUPPRESSIONS",
        group: { group: "2026-10-03T19:52:47.611Z", appliedAt: APPLIED, migrations: ["0100_email_0002_reasons"] },
        position: onTop(["0100_email_0002_reasons"]),
      },
    ]);

    expect(refusal.payload.message).toBe(
      "Refusing to roll back without a group. The newest group is 2026-10-03T19:52:47.611Z, applied 2026-10-03 19:52 UTC: DB holds 2000_app_0003_release_notes, EMAIL_SUPPRESSIONS holds 0100_email_0002_reasons.",
    );
    expect(refusal.payload.action).toBe("Reverse it with pithy migrate --rollback --group 2026-10-03T19:52:47.611Z.");
  });

  test("names each database's own newest group when they disagree, rather than choosing one", () => {
    const refusal = noGroupRefusal([
      {
        binding: "DB",
        group: { group: "release-7", appliedAt: APPLIED, migrations: ["2000_app_0003"] },
        position: onTop(["2000_app_0003"]),
      },
      {
        binding: "COLLAB_DB",
        group: { group: "release-6", appliedAt: new Date("2026-10-01T08:00:00.000Z"), migrations: ["0500_mp_0002"] },
        position: onTop(["0500_mp_0002"]),
      },
    ]);

    expect(refusal.payload.message).toBe(
      "Refusing to roll back without a group. These databases hold different newest groups: DB's is release-7, applied 2026-10-03 19:52 UTC (2000_app_0003); COLLAB_DB's is release-6, applied 2026-10-01 08:00 UTC (0500_mp_0002).",
    );
    // One command per database, because there is no single group to name and inventing one is how the
    // wrong thing gets reversed.
    expect(refusal.payload.action).toBe(
      "Reverse one database at a time: pithy migrate --rollback --group release-7 --binding DB.",
    );
  });

  test("says so when nothing in scope records a group at all", () => {
    const refusal = noGroupRefusal([{ binding: "DB" }, { binding: "COLLAB_DB" }]);

    expect(refusal.payload.message).toBe(
      "Refusing to roll back without a group. No database in scope records one: DB, COLLAB_DB.",
    );
    expect(refusal.payload.action).toBe(
      "Nothing here records which run applied a migration. Run pithy migrate to record a group, then reverse that group by name.",
    );
  });

  test("never prints a command for a newest group that the next invocation would refuse", () => {
    // The retry case the issue is built around: `release-7` applied m1, a hotfix applied m2, and the retry
    // of `release-7` applied m3. `release-7` is the newest group by the only order the group table has, and
    // `hotfix` is inside it — so each buries the other and neither can be reversed. Printing
    // `--rollback --group release-7` here handed over a command whose refusal named `hotfix`, whose refusal
    // named `release-7` back.
    const refusal = noGroupRefusal([
      {
        binding: "DB",
        group: { group: "release-7", appliedAt: APPLIED, migrations: ["2000_app_0001", "2000_app_0003"] },
        position: { state: "buried", above: ["hotfix"], ungrouped: [] },
      },
    ]);

    expect(refusal.payload.message).toBe(
      "Refusing to roll back without a group. No group holds the newest migrations: DB's newest is release-7, applied 2026-10-03 19:52 UTC, with hotfix applied over it.",
    );
    expect(refusal.payload.action).toBe(
      "Only a group holding the newest migrations can be reversed, and none here does. Run pithy doctor to see where each database stands.",
    );
    expect(refusal.payload.action).not.toContain("--rollback --group release-7");
  });

  test("names the group that is the contiguous tip, when the newest group is not it", () => {
    const refusal = noGroupRefusal([
      {
        binding: "DB",
        group: { group: "release-7", appliedAt: APPLIED, migrations: ["2000_app_0001"] },
        position: { state: "buried", above: ["hotfix"], ungrouped: [], top: "hotfix" },
      },
    ]);

    expect(refusal.payload.message).toBe(
      "Refusing to roll back without a group. The newest group recorded is not the one on top: DB's newest is release-7, applied 2026-10-03 19:52 UTC, with hotfix applied over it.",
    );
    expect(refusal.payload.action).toBe("Reverse the group on top: pithy migrate --rollback --group hotfix.");
  });

  test("names an applied migration no group claims, rather than a group it would not reverse", () => {
    // What a `pithy seed --redo` leaves when a migration was pending: the reset reapplies it under no
    // group, and no group rollback can step past it.
    const refusal = noGroupRefusal([
      {
        binding: "DB",
        group: { group: "release-7", appliedAt: APPLIED, migrations: ["2000_app_0001"] },
        position: { state: "buried", above: [], ungrouped: ["2000_app_0002_notes"] },
      },
    ]);

    expect(refusal.payload.message).toBe(
      "Refusing to roll back without a group. No group holds the newest migrations: DB's newest is release-7, applied 2026-10-03 19:52 UTC, with 2000_app_0002_notes (ungrouped) applied over it.",
    );
    expect(refusal.payload.action).toContain("Run pithy doctor");
  });
});

describe("sharedGroupRefusal", () => {
  test("names the group it was asked to reverse, and that none of it was", () => {
    const refusal = sharedGroupRefusal("EMAIL_SUPPRESSIONS", ["prod"], "staging", "release-7");

    expect(refusal.payload.message).toBe(
      "EMAIL_SUPPRESSIONS is bound by prod too. A staging rollback of group release-7 does not reverse it.",
    );
    expect(refusal.payload.action).toBe(
      "Reversing it would reverse prod with it. Run it against a database only staging binds.",
    );
    expect(refusal.payload.detail).toBe(
      "Nothing in release-7 was reversed: a group reverses completely or not at all.",
    );
  });

  test("is a down refusal, so it reaches the operator as itself rather than as a failed migration", () => {
    expect(isDownRefusal(sharedGroupRefusal("DB", ["prod"], "staging", "release-7"))).toBe(true);
  });
});

describe("buriedGroupRefusal", () => {
  test("states the rule and names the group that is actually on top", () => {
    const refusal = buriedGroupRefusal("DB", "release-6", ["release-7"], [], "release-7");

    expect(refusal.payload.message).toBe("Only the group on top can be reversed. DB applied release-7 over release-6.");
    expect(refusal.payload.action).toBe("Reverse release-7 first: pithy migrate --rollback --group release-7.");
    expect(refusal.payload.detail).toBe(
      "Kysely steps down from the tip, so reversing release-6 would reverse release-7 with it. Nothing was reversed.",
    );
  });

  test("names every group between it and the tip", () => {
    const refusal = buriedGroupRefusal("DB", "release-5", ["release-7", "release-6"], [], "release-7");

    expect(refusal.payload.message).toBe(
      "Only the group on top can be reversed. DB applied release-7, release-6 over release-5.",
    );
    expect(refusal.payload.action).toBe("Reverse release-7 first: pithy migrate --rollback --group release-7.");
  });

  test("names a migration no group claims as what buries it, and that nothing records it", () => {
    const refusal = buriedGroupRefusal("DB", "release-7", [], ["2000_app_0002_notes"]);

    expect(refusal.payload.message).toBe(
      "Only the group on top can be reversed. DB applied 2000_app_0002_notes (ungrouped) over release-7. Nothing records which run applied 2000_app_0002_notes.",
    );
    // There is no group to reverse first, so no command is printed: it would be one that refuses.
    expect(refusal.payload.action).toBe(
      "Only a group holding the newest migrations can be reversed, and none here does. Run pithy doctor to see where each database stands.",
    );
  });

  test("prints no command when the group over it is buried in its turn", () => {
    const refusal = buriedGroupRefusal("DB", "release-7", ["hotfix"], []);

    expect(refusal.payload.action).not.toContain("--group hotfix");
    expect(refusal.payload.action).toContain("Run pithy doctor");
  });
});

describe("missingDownRefusal", () => {
  test("names the migration with no down, and the group it stops", () => {
    const refusal = missingDownRefusal("DB", "release-7", ["1000_app_0002_more"]);

    expect(refusal.payload.message).toBe("Group release-7 cannot be reversed: DB's 1000_app_0002_more has no down.");
    expect(refusal.payload.action).toBe("Give 1000_app_0002_more a down, then reverse release-7 again.");
    expect(refusal.payload.detail).toBe(
      "Kysely leaves a migration with no down applied, so reversing the rest of release-7 would leave it half undone. Nothing was reversed.",
    );
  });

  test("names every one of them, so the operator fixes the group in one pass", () => {
    const refusal = missingDownRefusal("DB", "release-7", ["1000_app_0003_extra", "1000_app_0002_more"]);

    expect(refusal.payload.message).toBe(
      "Group release-7 cannot be reversed: DB's 1000_app_0003_extra, 1000_app_0002_more have no down.",
    );
    expect(refusal.payload.action).toBe("Give each of them a down, then reverse release-7 again.");
  });
});

describe("unknownGroupRefusal", () => {
  test("names the group nobody records, and the newest one that is there", () => {
    const refusal = unknownGroupRefusal("release-9", [
      {
        binding: "DB",
        group: { group: "release-7", appliedAt: APPLIED, migrations: ["2000_app_0003"] },
        position: onTop(["2000_app_0003"]),
      },
    ]);

    expect(refusal.payload.message).toBe('No database in scope records group "release-9".');
    expect(refusal.payload.action).toBe("Pass a group these databases record. DB's newest is release-7.");
  });

  test("says there is none when nothing in scope is grouped", () => {
    const refusal = unknownGroupRefusal("release-9", [{ binding: "DB" }]);

    expect(refusal.payload.message).toBe('No database in scope records group "release-9".');
    expect(refusal.payload.action).toBe("Pass a group these databases record. DB records none.");
  });
});
