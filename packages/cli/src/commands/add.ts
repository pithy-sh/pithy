// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative } from "node:path";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { type CliAuditEmit, type CreateCliAuditOptions, createRemoteCliAudit } from "../audit/cliAudit";
import type { ConfigValue } from "../capabilities/add";
import { buildCatalogListing } from "../capabilities/catalog";
import {
  type ConfigPrompt,
  coerceConfigValue,
  collectSetFlags,
  isHandWritten,
  type PrerequisitePrompt,
  runAdd,
} from "../capabilities/flow";
import { availableManifests } from "../capabilities/manifests";
import { requiredOptionRefusal } from "../capabilities/requiredOptions";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import type { DatabaseRun } from "../migrations/run";
import { loadProject, projectCloudflareAccount, requireProjectName } from "../project/config";
import { type ResolvedWorker, type ResolveOptions, resolveSingleWorker } from "../project/workerScope";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";

/** What {@link buildAudit} needs, plus the factory seam a test observes. */
export interface BuildAuditOptions {
  /**
   * The **project root** — the parent of `apps/`. Both halves of the lookup hang off it: the shared
   * `.dev.vars` holding the Cloudflare credentials, and the `apps/*` scan that resolves the audit
   * database. Passing a Worker directory here finds no `apps/`, so nothing is ever recorded.
   */
  projectDir: string;
  /** The target Worker's name — narrows the audit-database lookup to the Worker being wired. */
  worker: string;
  /** The environment the record lands in. */
  env: string;
  /** The target Worker's capabilities — auditing is wired only when `audit` is among them. */
  capabilities: Capability[];
  /**
   * The Cloudflare account this project belongs to, from `projectCloudflareAccount(projectDir)`, or
   * `null` when it names none. Required rather than defaulted: an audit written against the wrong
   * account is a record of this project's work in another company's database (#206).
   */
  account: CloudflareAccountSelection | null;
  /** Audit factory seam (default: {@link createRemoteCliAudit}). */
  create?: (options: CreateCliAuditOptions) => Promise<CliAuditEmit>;
}

/**
 * The audit emitter for the wiring commands, `pithy add` and `pithy remove`. Both act on **one** Worker
 * in a project, so the audit database is looked up from the project root and narrowed to that Worker.
 * `add` has no environment concept — a capability is wired into config, not deployed — so it passes
 * `"dev"`, which makes its emitter inert by design; `remove` passes the env its `--drop` destroys.
 *
 * A no-op when Cloudflare creds or the audit capability aren't there (which is always true the very
 * first time `pithy add audit` itself runs — nothing can audit-log its own installation).
 */
export async function buildAudit(options: BuildAuditOptions): Promise<CliAuditEmit> {
  const { projectDir, worker, env, capabilities, account } = options;
  const create = options.create ?? createRemoteCliAudit;
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return async () => {};
  return create({
    projectDir,
    worker,
    env,
    capabilities,
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/**
 * Pick the Worker interactively when a project has several and none was named. Supplied only when a
 * human is attached — an agent run (`--json`, no TTY) gets the actionable error from
 * {@link resolveSingleWorker} instead of a prompt it cannot answer.
 */
export async function promptWorker(choices: ResolvedWorker[]): Promise<string> {
  const { isCancel, select } = await import("@clack/prompts");
  const answer = await select({
    message: "Which worker?",
    options: choices.map((choice) => ({ value: choice.name, label: choice.name })),
  });
  if (isCancel(answer)) {
    process.stderr.write("Canceled.\n");
    process.exit(1);
  }
  return answer as string;
}

/** Options for {@link targetWorker}: the project, the `--worker` value, and whether a human is attached. */
export interface TargetWorkerOptions extends ResolveOptions {
  /** The `--worker` value, when one was passed. */
  worker?: string;
  /** True only at a real terminal without `--json` — the one condition a prompt is answerable. */
  interactive: boolean;
}

/**
 * The Worker a wiring command acts on — shared by `pithy add` and `pithy remove`, which must resolve it
 * the same way. `--worker` names it; a single-Worker project needs no ceremony; several Workers prompt a
 * human and raise an actionable error for anyone else. The prompt is attached **only** when a human is
 * attached, so an agent driving `--json` is told what to pass instead of hanging on a question.
 */
export function targetWorker(options: TargetWorkerOptions): Promise<ResolvedWorker> {
  const { interactive, worker, ...resolve } = options;
  return resolveSingleWorker({
    ...resolve,
    ...(worker === undefined ? {} : { worker }),
    ...(interactive ? { prompt: promptWorker } : {}),
  });
}

/**
 * `pithy add --list`: the built-in catalog, with installed capabilities marked.
 *
 * A package whose manifest is present and unusable is named, with the reason. It used to be dropped in
 * silence — the capability was simply absent from the listing, and the command an adopter runs *because*
 * something is missing was the command that said nothing about it (#184). Reported rather than refused:
 * one broken package must not cost the adopter the other fifteen entries.
 */
async function listCapabilities(projectDir: string, json: boolean): Promise<void> {
  const { manifests, faults } = await availableManifests(projectDir);
  const listing = buildCatalogListing(new Set(manifests.map((manifest) => manifest.name)));
  if (json) {
    process.stdout.write(`${formatJsonLine({ command: "add", capabilities: listing, manifestFaults: faults })}\n`);
    return;
  }
  const rows = listing.map((entry) => ({
    name: entry.name,
    description: entry.installed ? `${entry.whenToEnable} (installed)` : entry.whenToEnable,
  }));
  process.stdout.write(`${formatList(rows)}\n`);
  for (const fault of faults) {
    process.stderr.write(`${fault.package} ships a malformed pithy.manifest.json. Not listed.\n${fault.reason}\n`);
  }
}

/**
 * The project name `add` works under — resolved **here**, at the command edge, and handed to
 * {@link runAdd} as a plain string. It does two jobs: it leads every resource name `add` proposes, and
 * it claims the database `add`'s closing dev migration writes to.
 *
 * `requireProjectName`, never `resolveProjectName`: the lenient resolver's fallbacks (the
 * alphabetically-first worker, then the directory basename) differ between machines and checkouts, so a
 * later command would recompute a different name for the same resource — and stamp a different owner on
 * the same database. It throws rather than guessing, and it throws **here**, before the package is
 * installed and the Worker is wired, so a nameless project is told to set `name` instead of being left
 * half-configured around an unowned database.
 */
function proposalProject(projectDir: string): Promise<string> {
  return loadProject(projectDir).then(requireProjectName);
}

/** One line per database migrated, brand-voiced (docs/CLI.md §3). */
function describeRun(run: DatabaseRun): string {
  return run.results.length === 0
    ? `${run.database}: nothing to apply.`
    : `${run.database}: ${run.results.length} applied.`;
}

/**
 * The first entry offered for a **required** closed-set option, and the one `select` opens on.
 *
 * `@clack/prompts`' `select` has no unselected state: it highlights its first option and enter accepts it.
 * So "offer no `initialValue`" does not mean "nothing is pre-committed" — it means the first choice is, and
 * for `billingSubject` that is enter silently picking a billing model, which is the exact defect #412
 * exists to close. An unanswerable first entry is what actually gives the prompt no default: enter lands
 * here, and here refuses.
 *
 * The empty string cannot collide with a real choice — `ConfigOption.choices` are non-empty printable
 * strings — so it is unambiguous as a sentinel.
 */
const UNANSWERED_CHOICE = "";

/**
 * Fill un-set options interactively — a human-attached run prompts from the manifest.
 *
 * **What the option states decides what it is asked with.** A closed set is a `select` over its choices,
 * because a free-text field that only accepts three answers is a quiz. And an option with **no default** is
 * offered nothing to accept, in either shape: a `select` opens on {@link UNANSWERED_CHOICE}, and a `text`
 * gets no `defaultValue` and no `placeholder`. Both then refuse an unanswered enter with the same error a
 * `--json` run gets, naming the same flag — so the guarantee is one guarantee rather than one per transport.
 *
 * It used to hand `String(option.default)` to every prompt, which is how pressing enter picked a billing
 * model (#412).
 */
const promptConfigValues: ConfigPrompt = async (manifest, provided) => {
  const { isCancel, select, text } = await import("@clack/prompts");
  const values: Record<string, ConfigValue> = { ...provided };
  for (const option of manifest.configOptions) {
    if (option.key in values) continue;
    // Left as the manifest scaffolds it. A secrets registry is not something anyone types at a prompt,
    // and the fallback offered would have been the string "[object Object]".
    if (isHandWritten(option)) continue;
    // **A choice `pithy add` refuses is not offered, and the prompt says why it is missing (#483).**
    // Selecting it would be refused a moment later by the same rule `--set` is held to, and a select
    // whose entries are not all selectable is a worse prompt than a shorter one. Naming the absent value
    // matters too: `organization` is the mode a B2B project is looking for, and a list that simply does
    // not contain it reads as "unsupported" rather than "needs one line you have to write".
    const needsCode = option.choicesNeedingCode ?? {};
    const offered = option.choices?.filter((choice) => needsCode[choice] === undefined);
    const withheld = Object.entries(needsCode).filter(([choice]) => option.choices?.includes(choice));
    const message = [
      `${option.key} — ${option.describe}`,
      ...withheld.map(([choice, why]) => `  ${choice}: not offered here. ${why}`),
    ].join("\n");
    const required = option.default === undefined;
    const answer = offered
      ? await select({
          message,
          options: [
            // Only for a required option: an optional one has a default that enter should accept, which is
            // the whole point of having one.
            ...(required ? [{ value: UNANSWERED_CHOICE, label: "Choose one" }] : []),
            ...offered.map((choice) => ({ value: choice, label: choice })),
          ],
          ...(typeof option.default === "string" ? { initialValue: option.default } : {}),
        })
      : await text({
          message,
          // Absent for a required option, both of them: `defaultValue` is what enter accepts and
          // `placeholder` is what says so. There is nothing here to accept.
          ...(option.default === undefined
            ? {}
            : { defaultValue: String(option.default), placeholder: String(option.default) }),
        });
    if (isCancel(answer)) {
      process.stderr.write("Canceled.\n");
      process.exit(1);
    }
    // An unanswered required option is refused rather than written. `text` returns "" for a bare enter and
    // `select` returns the sentinel, and both mean the same thing: nobody chose. Writing either would put
    // an empty key into the adopter's config for them to find later — which is worse than the question.
    if (required && (answer === UNANSWERED_CHOICE || answer === "")) {
      throw requiredOptionRefusal({ capability: manifest.name, missing: [option] });
    }
    values[option.key] = coerceConfigValue(option, answer, manifest.name);
  }
  return values;
};

/**
 * Ask whether to compose a capability's prerequisites too — one question for the whole cascade.
 *
 * Attached only when a human is attached, exactly like the Worker picker above it. Declining is a
 * refusal, not a silent partial add: the caller raises the error that names the commands, so a `no` here
 * and a non-interactive run reach the same place by different roads.
 */
const promptPrerequisites: PrerequisitePrompt = async ({ capability, missing }) => {
  const { confirm, isCancel } = await import("@clack/prompts");
  const one = missing.length === 1;
  const answer = await confirm({
    message: `${capability} requires ${missing.join(", ")}. Compose ${one ? "it" : "them"} too?`,
  });
  if (isCancel(answer)) {
    process.stderr.write("Canceled.\n");
    process.exit(1);
  }
  return answer === true;
};

export default defineCommand({
  meta: { name: "add", description: "Add a capability" },
  args: {
    // Optional so `pithy add --list` runs without a capability.
    capability: { type: "positional", required: false, description: "Capability name, e.g. auth" },
    list: { type: "boolean", default: false, description: "List the capabilities you can add" },
    worker: { type: "string", description: "Which worker to wire it into (apps/<name>)" },
    set: { type: "string", description: "Override a config option: --set key=value (repeatable)" },
    eject: {
      type: "boolean",
      default: false,
      description: "Copy the capability's source into your repo and own it (no upgrades)",
    },
    force: {
      type: "boolean",
      default: false,
      description: "With --eject, overwrite an existing local copy (discards edits)",
    },
    "with-prerequisites": {
      type: "boolean",
      default: false,
      description: "Compose the capabilities this one requires, if they aren't composed yet",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  // `ctx` over `{ args }`: repeated `--set` only survives in rawArgs (citty keeps
  // the last value of a repeated string flag), so collectSetFlags reads it there.
  run: ({ args, rawArgs }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      if (args.list) {
        await listCapabilities(projectDir, args.json);
        return;
      }
      if (!args.capability) {
        throw new ValidationError({
          message: "Name a capability to add.",
          action: "Run pithy add --list to see what's available.",
        });
      }

      const interactive = !args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
      // Which Worker gets the wiring. One worker needs no ceremony; several never guess.
      const target = await targetWorker({
        projectDir,
        interactive,
        ...(args.worker === undefined ? {} : { worker: args.worker }),
      });

      // Resolved once and used three times over: the store id `add secrets` records, the migrate it
      // finishes with, and the audit trail. Every one of them belongs to the account this project names
      // rather than to whichever `cloudflare.json` the machine happens to hold (#234).
      const account = await projectCloudflareAccount(projectDir);

      const result = await runAdd({
        projectDir,
        workerDir: target.dir,
        worker: target.name,
        project: await proposalProject(projectDir),
        account,
        capability: args.capability,
        setFlags: collectSetFlags(rawArgs),
        prompt: interactive ? promptConfigValues : undefined,
        withPrerequisites: args["with-prerequisites"],
        askPrerequisites: interactive ? promptPrerequisites : undefined,
        eject: args.eject,
        force: args.force,
        audit: await buildAudit({
          projectDir,
          account,
          worker: target.name,
          env: "dev",
          capabilities: target.capabilities,
        }),
      });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "add", ...result })}\n`);
        return;
      }
      // Said first, because it happened first, and because a capability composed on the adopter's behalf
      // is the one thing in this output they did not type.
      if (result.prerequisites.length > 0) {
        process.stdout.write(
          `Composed ${result.prerequisites.join(", ")} into ${result.worker} first — ${result.capability} requires ${result.prerequisites.length === 1 ? "it" : "them"}.\n`,
        );
      }
      process.stdout.write(`Wired ${result.capability} into ${result.worker}.\n`);
      for (const run of result.databases) {
        process.stdout.write(`${describeRun(run)}\n`);
      }
      // KV titles are printed rather than written: a `kv_namespaces` entry has no title field, so the
      // only place the name can land is the account. D1's went into wrangler.jsonc as `database_name`.
      for (const kv of result.kvNamespaces) {
        process.stdout.write(`Name the ${kv.binding} namespace for ${kv.env}: ${kv.name}\n`);
      }
      // What add finished off-config, and what only a provision command can supply. Printed here, at
      // the moment the adopter is thinking about the capability — not left to the first 500.
      for (const note of result.notes) {
        process.stdout.write(`${note}\n`);
      }
      if (result.eject) {
        // The fork lands beside the Worker's config, so report it project-relative: apps/<worker>/capabilities/<cap>.
        const path = relative(projectDir, join(target.dir, result.eject.path));
        process.stdout.write(
          `Ejected ${result.capability} into ${path}/. It's yours now — ${result.package} no longer upgrades it.\n`,
        );
        if (result.eject.promotedDependencies.length > 0) {
          process.stdout.write(
            `Promoted ${result.eject.promotedDependencies.length} dependencies. ${result.package} is safe to remove.\n`,
          );
        }
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});
