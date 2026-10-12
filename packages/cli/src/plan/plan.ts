// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * **One plan shape for every `--dry-run` (#697).**
 *
 * A dry run exists so an agent can show a person what a command will change before it changes it, and
 * that only works if the agent can read every command's answer the same way. Five commands planned before
 * this, each in its own words: `upgrade` spread a reconcile plan, `seed` listed rows, `secrets rotate` said
 * `reason: "dry-run"`, `feature prune` listed blocks, `payments reconcile` passed a Workflow's report out.
 * They keep those keys, because a key a parser reads is never taken away. Each also carries `plan`, this
 * shape, under every `--dry-run --json`, and so does every command that gained the flag after them.
 *
 * **Every list is always present.** An absent list and an empty one would be two spellings of "nothing of
 * this kind", and a consumer that reads `plan.files.length` must not have to ask which it got.
 *
 * **What a plan cannot settle without making the change goes in `notes`, said plainly.** A plan that
 * leaves a step out reads as a promise that the step does not happen.
 */

/** What happens to one file or directory. */
export const PlanFileAction = z
  .enum(["create", "edit", "delete", "move"])
  .describe(
    "`create` — written where nothing is. `edit` — rewritten in place. `delete` — removed. `move` — `from` becomes `path`, contents and all.",
  );
export type PlanFileAction = z.infer<typeof PlanFileAction>;

/** One file or directory the command would write. */
export const PlanFile = z
  .object({
    path: z
      .string()
      .describe(
        "Where it lands, relative to the project root with `/` separators. Absolute only for a file outside the project, such as the machine's port registry.",
      ),
    action: PlanFileAction,
    from: z.string().optional().describe("Where a `move` starts, relative to the project root. Only on `move`."),
    changes: z
      .array(z.string().describe("One change, in a sentence."))
      .describe("What changes in it, one sentence each. Empty when `diff` says it all."),
    diff: z
      .string()
      .optional()
      .describe(
        "The change as a unified diff of the file's text, hunks only. Absent on a `delete`, a `move`, a binary file, and where the command knows what changes but not the bytes.",
      ),
  })
  .describe("One file or directory the command would write.");
export type PlanFile = z.infer<typeof PlanFile>;

/** One Cloudflare resource the command would create, adopt, or upload. */
export const PlanResource = z
  .object({
    kind: z
      .enum(["d1", "kv", "r2", "vectorize", "worker", "workflow", "secrets_store"])
      .describe("The kind of Cloudflare resource."),
    name: z.string().describe("Its name in the account."),
    binding: z.string().optional().describe("The Worker binding it backs, when it backs one."),
    env: z.string().optional().describe("The environment it belongs to."),
    action: z
      .enum(["create", "adopt", "upload", "unknown"])
      .describe(
        "`create` — nothing by that name exists, so one would be made. `adopt` — one exists and would be used. `upload` — a Worker script would be uploaded. `unknown` — the account could not be asked; `reason` says why.",
      ),
    id: z.string().optional().describe("The existing resource's id. Only on `adopt`."),
    reason: z.string().optional().describe("Why the action is what it is, when that is not obvious."),
  })
  .describe("One Cloudflare resource the command would create, adopt, or upload.");
export type PlanResource = z.infer<typeof PlanResource>;

/** One migration the command would apply or roll back. */
export const PlanMigration = z
  .object({
    env: z.string().describe("The environment whose database it runs against."),
    worker: z.string().describe("The Worker that declares it."),
    database: z.string().describe("The database name — a capability's `databases` key."),
    binding: z.string().describe("The D1 binding the database resolves to."),
    name: z.string().describe("The migration's name, as the ledger records it."),
    direction: z.enum(["up", "down"]).describe("`up` applies it. `down` rolls it back."),
  })
  .describe("One migration the command would apply or roll back.");
export type PlanMigration = z.infer<typeof PlanMigration>;

/** One secret value the command would write. Never the value. */
export const PlanSecret = z
  .object({
    name: z.string().describe("The secret's name."),
    env: z.string().optional().describe("The environment it belongs to."),
    action: z
      .enum(["mint", "write", "rotate", "bind"])
      .describe(
        "`mint` — a new value is generated and stored. `write` — a value already known is stored somewhere new. `rotate` — a new version replaces the current one. `bind` — an existing entry is bound to a Worker.",
      ),
    where: z.string().describe("Where the value lands: a file, a store, or a rotation's kind."),
  })
  .describe("One secret the command would write. The value is never part of a plan.");
export type PlanSecret = z.infer<typeof PlanSecret>;

/** Rows, entries, or objects the command would write into a store that already exists. */
export const PlanData = z
  .object({
    worker: z.string().optional().describe("The Worker whose binding it goes through, when one does."),
    store: z
      .string()
      .describe("The kind of store: `d1`, `kv`, `r2`, `media`, or the capability that owns it, such as `payments`."),
    target: z.string().describe("What it lands in: a table, a namespace, a key, a rail."),
    count: z.number().int().nonnegative().describe("How many rows, entries, or objects."),
    action: z
      .enum(["write", "upload", "reupload", "skip", "reset", "repair"])
      .describe(
        "`write` — written. `upload` and `reupload` — sent to a media store, the second replacing what is there. `skip` — already there, left alone. `reset` — dropped and rebuilt. `repair` — corrected to match its source.",
      ),
  })
  .describe("Rows, entries, or objects the command would write into a store that already exists.");
export type PlanData = z.infer<typeof PlanData>;

/** Everything one `--dry-run` would change, and what it could not settle without changing it. */
export const Plan = z
  .object({
    files: z.array(PlanFile).describe("Files and directories it would write, in the order it would write them."),
    resources: z.array(PlanResource).describe("Cloudflare resources it would create, adopt, or upload."),
    migrations: z.array(PlanMigration).describe("Migrations it would apply or roll back, in order."),
    secrets: z.array(PlanSecret).describe("Secrets it would mint, write, rotate, or bind."),
    data: z.array(PlanData).describe("Rows, entries, and objects it would write into existing stores."),
    notes: z
      .array(z.string().describe("One sentence."))
      .describe("What the plan could not settle without making the change, one sentence each."),
  })
  .describe("Everything one `--dry-run` would change. Every list is always present, empty when there is nothing.");
export type Plan = z.infer<typeof Plan>;

/**
 * The `plan` key of a payload whose dry run is one of its runs: present under `--dry-run`, absent otherwise.
 * The inner schema is {@link Plan} itself, never a copy, which is what `test-utils/planSlots.ts` checks.
 */
export const PlanKey = Plan.optional().describe("What `--dry-run` would change. Present only under `--dry-run`.");

/** A plan with nothing in it. */
export function emptyPlan(): Plan {
  return { files: [], resources: [], migrations: [], secrets: [], data: [], notes: [] };
}

/** `--dry-run`, declared once, so every command that plans says the same thing about it. */
export const DRY_RUN_ARG = {
  type: "boolean",
  default: false,
  description: "Show the plan and write nothing",
} as const;

/** `(DB, staging)`, `(DB)`, `(staging)`, or nothing. */
function qualifier(...parts: (string | undefined)[]): string {
  const present = parts.filter((part): part is string => part !== undefined && part !== "");
  return present.length === 0 ? "" : ` (${present.join(", ")})`;
}

/**
 * A plan as lines a person reads, in the plan's own order: files, resources, migrations, secrets, data,
 * then the notes. The command prints its own closing line, `Dry run. Nothing written.` on most of them.
 */
export function planText(plan: Plan): string[] {
  const lines: string[] = [];
  for (const file of plan.files) {
    lines.push(
      file.action === "move" ? `Would move ${file.from} to ${file.path}.` : `Would ${file.action} ${file.path}.`,
    );
    for (const change of file.changes) lines.push(`  ${change}`);
  }
  for (const resource of plan.resources) {
    const verb = resource.action === "unknown" ? "need" : resource.action;
    lines.push(`Would ${verb} ${resource.kind} ${resource.name}${qualifier(resource.binding, resource.env)}.`);
  }
  for (const migration of plan.migrations) {
    const where = `${migration.database}${qualifier(migration.binding, migration.env)}`;
    lines.push(
      migration.direction === "up"
        ? `Would apply ${migration.name} to ${where}.`
        : `Would roll back ${migration.name} on ${where}.`,
    );
  }
  for (const secret of plan.secrets) {
    lines.push(`Would ${secret.action} ${secret.name}${qualifier(secret.env)} in ${secret.where}.`);
  }
  for (const data of plan.data) {
    lines.push(`Would ${data.action} ${data.count} to ${data.store} ${data.target}.`);
  }
  lines.push(...plan.notes);
  return lines.length === 0 ? ["Nothing to change."] : lines;
}
