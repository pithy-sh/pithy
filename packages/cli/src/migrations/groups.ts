// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import {
  type GroupPosition,
  type MigrationGroup,
  readGroupPosition,
  readMigrationGroups,
} from "@pithy-sh/core/src/migrations/groups";
import { downRefusal } from "@pithy-sh/core/src/migrations/retained";
import type { MigrationGroupStep } from "@pithy-sh/core/src/migrations/runner";
import type { DatabaseGroup, MigrationDriver } from "./run";

/**
 * **A rollback names the group it reverses, and the refusals are what say which one (#694).**
 *
 * `pithy migrate --rollback` used to step back one migration in every database in scope. What a single
 * command reversed therefore depended on what each database happened to apply last, and reversing a
 * deploy that moved three migrations was three invocations with the count coming from a human's memory.
 * The bare command reverses nothing now: it names the group on top, what that group holds per database,
 * and the command that reverses it — and `--rollback --group <value>` reverses exactly that.
 *
 * **Everything here refuses before anything moves.** A group rollback runs several `down`s across several
 * databases and there is no transaction over them, so each condition that can stop one of them is checked
 * across the whole group first ({@link planGroupRollback}). Reversing as it went would leave a group
 * half-undone the first time the third database refused, which is the exact state groups exist to
 * prevent. The pre-flight is why these messages are advice rather than an explanation of damage.
 *
 * The wordings live here rather than inside each check so they can be read side by side and tested as
 * strings: every one is a problem line naming the group, and an action line that is the command to type.
 */

/**
 * **The group value as it will be recorded: trimmed, and never blank.**
 *
 * `--group "$RELEASE"` with the variable unset is the shape this is for. An empty string is still a value,
 * so it would record, and every run that made the same mistake would extend one group — which is exactly
 * the silent merge of unrelated runs that a per-run timestamp exists to prevent. Trimmed for the retry
 * case: a stray space from a shell would make the second run's group a different group from the one it is
 * retrying, and nothing about the two would look different in a log.
 */
export function requireMigrationGroup(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const group = value.trim();
  if (group) return group;
  throw new ValidationError({
    message: "--group takes a value.",
    action: "Name the group this run belongs to, or leave --group off and let the run stamp itself.",
  });
}

/**
 * One database's newest group **and where that group sits in its chain** — what a refusal names when the
 * caller named none.
 *
 * The two travel together, as a union rather than two optional fields, because a refusal that has the group
 * and not the position is the bug this shape exists to prevent: it printed `--rollback --group <newest>` for
 * a group the next command refuses as buried, and both refusals then pointed at each other (#694).
 */
export type NewestGroup = { binding: string } & (
  | {
      /** Nothing here is grouped — a database last migrated by an older kit. */
      group?: undefined;
      position?: undefined;
    }
  | {
      /** Its newest group: the last one the group table records. */
      group: MigrationGroup;
      /** Where that group sits in this database's ledger. `top` is the one state that can be reversed. */
      position: GroupPosition;
    }
);

/** When a group applied, to the minute, in UTC — the one timezone an operator and a log agree on. */
export function appliedLabel(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** One database's newest group, with the position that says whether it can be reversed. */
type GroupedDatabase = NewestGroup & { group: MigrationGroup; position: GroupPosition };

/** `DB holds a, b` — one database's share of a group. */
function holding(entry: GroupedDatabase): string {
  return `${entry.binding} holds ${entry.group.migrations.join(", ")}`;
}

/**
 * Why one database's newest group is not the thing to reverse — the clause the blocked refusal is built
 * from. A group with another applied *inside* it, or an ungrouped migration over it, is not reversible,
 * and the migrations that bury it are what the operator has to see.
 */
function blocking(entry: GroupedDatabase): string {
  const newest = `${entry.binding}'s newest is ${entry.group.group}, applied ${appliedLabel(entry.group.appliedAt)}`;
  if (entry.position.state !== "buried") return `${newest}, and its migrations are no longer applied`;
  const over = [...entry.position.above, ...entry.position.ungrouped.map((name) => `${name} (ungrouped)`)];
  return `${newest}, with ${over.join(", ")} applied over it`;
}

/**
 * **The refusal for `pithy migrate --rollback` with no `--group`** — the breaking change, and the point
 * of the issue.
 *
 * It names the newest group, the migrations it holds in each database, and the exact command that
 * reverses it, because the alternative is making somebody run the wrong command once in order to learn
 * the right one. **When the databases disagree it names each one's own newest group rather than picking
 * one**: a `--worker`- or `--binding`-scoped run can leave two databases on different groups, there is no
 * single answer, and inventing one is how the wrong thing gets reversed.
 *
 * **And when the newest group is not on top, it says that instead of printing a command.** A group extended
 * after another run, or an ungrouped migration at the tip, leaves nothing reversible as a group; the
 * refusal names what buries it and points at `pithy doctor` rather than at a command that refuses.
 */
export function noGroupRefusal(newest: readonly NewestGroup[]): ValidationError {
  const opening = "Refusing to roll back without a group.";
  const grouped = newest.filter((entry): entry is GroupedDatabase => entry.group !== undefined);
  if (grouped.length === 0) {
    return new ValidationError({
      message: `${opening} No database in scope records one: ${newest.map((entry) => entry.binding).join(", ")}.`,
      action:
        "Nothing here records which run applied a migration. Run pithy migrate to record a group, then reverse that group by name.",
    });
  }

  // **Before naming a command: the newest group has to be reversible.** `readMigrationGroups` orders a
  // group by its last row, so a group extended after another one ran is the newest and is still buried
  // under that run — and an ungrouped migration at the tip buries whatever is beneath it. Printing
  // `--rollback --group <newest>` there hands over a command the next invocation refuses, and the refusal
  // it gets back names a group that is buried in its turn: a circle, with nothing reversible in it (#694).
  const blocked = grouped.filter((entry) => entry.position.state !== "top");
  if (blocked.length > 0) {
    const tips = blocked.map((entry) => (entry.position.state === "buried" ? entry.position.top : undefined));
    const [tip] = tips;
    const onTop = tip !== undefined && tips.every((candidate) => candidate === tip) ? tip : undefined;
    const named = blocked.map(blocking).join("; ");
    return new ValidationError({
      // The lead-in has to match the action: *no group* is the honest opening only when there is none to
      // name, and a tip group that is simply not the newest row in the table is a different sentence.
      message: onTop
        ? `${opening} The newest group recorded is not the one on top: ${named}.`
        : `${opening} No group holds the newest migrations: ${named}.`,
      action: onTop
        ? `Reverse the group on top: pithy migrate --rollback --group ${onTop}.`
        : "Only a group holding the newest migrations can be reversed, and none here does. Run pithy doctor to see where each database stands.",
      detail: "Kysely steps down from the tip, so a group with anything over it cannot come down alone.",
    });
  }

  const [first] = grouped;
  const agreed = first !== undefined && grouped.every((entry) => entry.group.group === first.group.group);
  if (agreed && first) {
    return new ValidationError({
      message: `${opening} The newest group is ${first.group.group}, applied ${appliedLabel(first.group.appliedAt)}: ${grouped.map(holding).join(", ")}.`,
      action: `Reverse it with pithy migrate --rollback --group ${first.group.group}.`,
    });
  }
  const named = grouped
    .map(
      (entry) =>
        `${entry.binding}'s is ${entry.group.group}, applied ${appliedLabel(entry.group.appliedAt)} (${entry.group.migrations.join(", ")})`,
    )
    .join("; ");
  return new ValidationError({
    message: `${opening} These databases hold different newest groups: ${named}.`,
    action: `Reverse one database at a time: pithy migrate --rollback --group ${first?.group.group} --binding ${first?.binding}.`,
  });
}

/**
 * **The refusal for a group that is not on top.** Kysely steps down from the tip, so reversing a buried
 * group would mean reversing everything over it — migrations from groups nobody named, or migrations no
 * group records at all. The rule is in the detail line and what buries it is in the problem line, because
 * those are the two facts the operator needs: what they may do, and what is in the way.
 *
 * **The action names a group only when one is genuinely on top.** `onTop` comes from the position read,
 * which tests the candidate rather than assuming the newest of what is over it qualifies — after a group
 * was extended over another one, each is inside the other and *reverse that one first* would be a command
 * whose own refusal names the group the operator started from (#694).
 */
export function buriedGroupRefusal(
  binding: string,
  group: string,
  above: readonly string[],
  ungrouped: readonly string[] = [],
  onTop?: string,
): ValidationError {
  const over = [...above, ...ungrouped.map((name) => `${name} (ungrouped)`)].join(", ");
  const unrecorded = ungrouped.length === 0 ? "" : ` Nothing records which run applied ${ungrouped.join(", ")}.`;
  return new ValidationError({
    message: `Only the group on top can be reversed. ${binding} applied ${over} over ${group}.${unrecorded}`,
    // Only a group that *is* the contiguous tip is named: suggesting a group buried in its turn sends the
    // operator in a circle, and after a group was extended over another one neither is on top (#694).
    action: onTop
      ? `Reverse ${onTop} first: pithy migrate --rollback --group ${onTop}.`
      : "Only a group holding the newest migrations can be reversed, and none here does. Run pithy doctor to see where each database stands.",
    detail: `Kysely steps down from the tip, so reversing ${group} would reverse ${over} with it. Nothing was reversed.`,
  });
}

/** The refusal for a group no database in scope records — a typo, or a group reversed already. */
export function unknownGroupRefusal(group: string, newest: readonly NewestGroup[]): NotFoundError {
  const named = newest
    .map((entry) =>
      entry.group ? `${entry.binding}'s newest is ${entry.group.group}` : `${entry.binding} records none`,
    )
    .join(", ");
  return new NotFoundError({
    message: `No database in scope records group "${group}".`,
    action: `Pass a group these databases record. ${named}.`,
  });
}

/**
 * The refusal for a database another environment binds that holds part of the group (#588, #694).
 *
 * The multi-binding rule itself is unchanged — `EMAIL_SUPPRESSIONS` is production's suppression list too,
 * so a `staging` rollback never reverses it. What the group adds is that it fires **here**, in the
 * pre-flight, and **names the group it was asked to reverse**: the group cannot be reversed completely,
 * so none of it is reversed at all, and the operator reads that before anything has moved.
 */
export function sharedGroupRefusal(
  binding: string,
  boundBy: readonly string[],
  env: string,
  group: string,
): ValidationError {
  const others = boundBy.join(", ");
  return downRefusal(
    new ValidationError({
      message: `${binding} is bound by ${others} too. A ${env} rollback of group ${group} does not reverse it.`,
      action: `Reversing it would reverse ${others} with it. Run it against a database only ${env} binds.`,
      detail: `Nothing in ${group} was reversed: a group reverses completely or not at all.`,
    }),
  );
}

/**
 * **The refusal for a group holding a migration with no `down` (#694).**
 *
 * Kysely steps down from the tip and reverses a migration only `if (migration.down)` — one without it is
 * reported `NotExecuted` and stays applied. So a group holding one cannot come down whole, and reversing
 * the migrations above it would leave the group half undone with nothing saying so: the command exited 0
 * and named every migration in the group as rolled back. It is raised here, in the pre-flight, for the
 * same reason the shared-database one is — the condition is per database, and a group reverses completely
 * or not at all.
 *
 * The action is the only remedy there is. A reset does not help: `migrateDown` skips a missing `down`
 * whatever the target, so `pithy seed --redo` would leave exactly the same migration applied.
 */
export function missingDownRefusal(binding: string, group: string, migrations: readonly string[]): ValidationError {
  const named = migrations.join(", ");
  const one = migrations.length === 1;
  return new ValidationError({
    message: `Group ${group} cannot be reversed: ${binding}'s ${named} ${one ? "has" : "have"} no down.`,
    action: `Give ${one ? named : "each of them"} a down, then reverse ${group} again.`,
    detail: `Kysely leaves a migration with no down applied, so reversing the rest of ${group} would leave it half undone. Nothing was reversed.`,
  });
}

/** What {@link planGroupRollback} is asked about: the databases, the ones kept back, and the group named. */
export interface GroupRollbackPlanOptions {
  /** The environment being rolled back — what the shared-database refusal names. */
  env: string;
  /** The open driver, already holding a D1 per database in scope. */
  driver: MigrationDriver;
  /** The databases this run would reverse, in run order. */
  databases: readonly DatabaseGroup[];
  /** The databases set aside because another environment binds them. Read, never reversed. */
  kept: readonly DatabaseGroup[];
  /** The group the caller named, or `undefined` when they named none. */
  requested: string | undefined;
}

/**
 * **The pre-flight: every refusal condition, across every database in the group, before anything is
 * reversed.**
 *
 * It returns one step per database that holds part of the group — what {@link
 * reverseMigrationGroup} reverses there, newest migration first — or it throws, with nothing moved. A
 * database that holds none of the group gets no step and is left alone, which is ordinary: a group
 * narrowed by `--binding`, or a release that only touched one database, is not a group half-reversed.
 *
 * The retained-rows refusal is the one condition this does not raise. It is counted over exactly the
 * databases this plan reverses, by the caller, right after — `assertRetainedCounted`, one budget across
 * the group (#588).
 *
 * The conditions it does raise are the shared database another environment binds, a group that is not the
 * top of a chain, and a migration in the group with no `down` — each per database, each checked across the
 * whole group before the first `down`.
 */
export async function planGroupRollback(
  options: GroupRollbackPlanOptions,
): Promise<Map<DatabaseGroup, MigrationGroupStep>> {
  if (options.requested === undefined) {
    throw noGroupRefusal(await newestGroups(options.driver, options.databases));
  }
  const requested = options.requested;

  // The databases a rollback never reverses, first: one of them holding part of the group means the group
  // cannot come down whole, so none of it should come down at all.
  for (const database of options.kept) {
    const position = await readGroupPosition(options.driver.database(database), requested);
    if (position.state !== "absent") {
      throw sharedGroupRefusal(database.binding, database.boundBy, options.env, requested);
    }
  }

  const steps = new Map<DatabaseGroup, MigrationGroupStep>();
  for (const database of options.databases) {
    const position = await readGroupPosition(options.driver.database(database), requested);
    if (position.state === "buried") {
      throw buriedGroupRefusal(database.binding, requested, position.above, position.ungrouped, position.top);
    }
    if (position.state === "top") {
      await assertEveryMigrationReverses(database, requested, position.migrations);
      steps.set(database, { group: requested, migrations: position.migrations });
    }
  }
  if (steps.size === 0) {
    throw unknownGroupRefusal(requested, await newestGroups(options.driver, options.databases));
  }
  return steps;
}

/**
 * Refuse unless every migration this database would reverse has a `down` — the third per-database
 * condition that can stop a `down`, beside the shared binding and the retained rows.
 *
 * Read from the registry the run composed, so it costs no round trip. A ledger row the provider does not
 * carry at all is `assertLedgerDeclared`'s refusal and has already been raised by the time this runs, so
 * an absent entry here is genuinely a migration whose author wrote no `down`.
 */
async function assertEveryMigrationReverses(
  database: DatabaseGroup,
  group: string,
  migrations: readonly string[],
): Promise<void> {
  const declared = await database.provider.getMigrations();
  const missing = migrations.filter((name) => declared[name]?.down === undefined);
  if (missing.length > 0) throw missingDownRefusal(database.binding, group, missing);
}

/**
 * Each database's newest group **and where it sits**, in run order — what the refusals name.
 *
 * The position is read here rather than concluded by the refusal, because the group table's own order
 * cannot answer it: a group extended after another run is the newest by that order and buried in the
 * ledger. A database with nothing grouped contributes neither (#694).
 */
async function newestGroups(driver: MigrationDriver, databases: readonly DatabaseGroup[]): Promise<NewestGroup[]> {
  const newest: NewestGroup[] = [];
  for (const database of databases) {
    const d1 = driver.database(database);
    const last = (await readMigrationGroups(d1)).at(-1);
    newest.push(
      last
        ? { binding: database.binding, group: last, position: await readGroupPosition(d1, last.group) }
        : { binding: database.binding },
    );
  }
  return newest;
}
