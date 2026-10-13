// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Command, pithyCommand, type WorkerDir } from "@pithy-sh/core/src/cli/command";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { z } from "zod";
import { providerExample } from "../capabilities/entitlementGap";
import { undeclinableReason } from "../capabilities/reconcile";
import type { DoctorReport } from "../commands/doctor";
import { describeUndeclared } from "../migrations/ledger";
import { describeOriginDrift, originDriftFix } from "../project/domains";
import { describeWorkflowDrift, workflowDriftFix } from "../project/workflows";
import { provisionFixCommand } from "../provision/provisionFix";
import { isFixable, repointableIds } from "./bindingScope";
import { describeCloudflareAccess } from "./cloudflare";
import { describeDevPreferences } from "./devPreferences";
import { describeEnvironmentDrift } from "./environments";
import { capabilityReachFix, DoctorFix, migrationFix, prerequisiteFix, upgradeFix } from "./findingFixes";
import type { ProjectHealth, WorkerChecks } from "./health";
import { describeProjectName } from "./projectName";
import { describeSelfBinding } from "./selfBinding";
import { describeSettingsFinding } from "./settings";
import { describeSupportSearchTriggers, supportSearchFix } from "./supportSearchTriggers";
import { describeReservedWorkerName, describeWorkerName } from "./workerName";

/**
 * **Every check that fails `pithy doctor`, with the command that rights it (#697).**
 *
 * `doctor` finds what is wrong and, until this, left an agent to read the docs for the command that fixes it.
 * The text report names a remedy in prose beside most findings; an agent reading `--json` had the finding and
 * no command. So each failing check is one entry here — the block it sits in, its sentence, and its `fix`.
 *
 * **This list is the exit gate.** `doctorExitCode` is "is this list empty", so a check cannot fail the exit
 * without an entry here, and an entry cannot exist for something that does not fail it. Findings that report
 * and never gate — a deployed environment's migrations, an unbound secret, a docs client nobody connected —
 * are the report's blocks and not failures, on the standard every branch below states: only a fault this
 * project's own files or an account that answered positively establishes may gate CI. They carry their own
 * `fix` in their blocks, and where a finding is both, the two are built by the same function in
 * `findingFixes.ts`.
 *
 * **`fix` is a `pithy` command run as written, or `null` — never prose, and never a guess.** The same rule as
 * the error line's `fix` (`terminal/exitClass.ts`), but not held by the same gate. The commands here are
 * passed positionally and most interpolate a name, so `ci/actionLines.test.ts` sees only their flags, through
 * its pass over every string literal, and never their command paths. The gate is `failures.test.ts`: it
 * builds a report for every branch below and runs each `fix` it produces against the real command tree and
 * its declared flags. A branch added here without a case there is a `fix` nothing checks. `null` is the
 * honest answer in three cases, and `detail` says which one it is:
 *
 * - **The remedy is an edit.** A stanza to add, a name to change, a line to delete. No command writes it, and
 *   naming one that does something adjacent is the defect #517 took four rounds to remove.
 * - **The remedy is a person's.** Provisioning a production environment needs its `--confirm` phrase, so it
 *   names none, as `provision/provisionFix.ts` decides for the error line.
 * - **The command exists and running it blind would lose data.** Repointing a project-global binding before
 *   the rows are carried across empties it; the report's own lines walk a person through the carry first.
 *
 * Built from each finding's fields, never from the text renderer's sentences — those still read
 * `pithy provision --env <name>` in places, and a `fix` is something an agent runs.
 */

/** Which block of the report a failure sits in — the `--json` key it is reported under. */
export const DoctorCheck = z
  .enum([
    "project",
    "cloudflare",
    "projectName",
    "workerNames",
    "selfBinding",
    "featureRatelimitIds",
    "environments",
    "environmentConfigs",
    "origins",
    "workflows",
    "supportSearchTriggers",
    "devPreferences",
    "settings",
  ])
  .describe("The block of the report the failure sits in: its `--json` key. `project` covers project health.");
export type DoctorCheck = z.infer<typeof DoctorCheck>;

/** One check that fails the exit, and what rights it. */
export const DoctorFailure = z
  .object({
    check: DoctorCheck,
    detail: z.string().min(1).describe("What is wrong, in one sentence, naming the Worker and environment."),
    fix: DoctorFix,
  })
  .describe("One check that fails `pithy doctor`'s exit, and the command that rights it.");
export type DoctorFailure = z.infer<typeof DoctorFailure>;

/** The `failures` key of `pithy doctor --json`. Empty exactly when the exit is 0. */
export const DoctorFailures = z
  .array(DoctorFailure)
  .describe("Every check that fails the exit, each with its `fix`. Empty exactly when `pithy doctor` exits 0.");

/** A sentence, ending in one period. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * One checked Worker's failing checks. Every branch is one of the five `ok`s `healthFromPlan` ANDs, and a
 * Worker whose `ok` is false and that matched none of them still gets an entry, so the list cannot be short
 * of the gate it replaces.
 */
function workerFailures(worker: string, directory: WorkerDir, checks: WorkerChecks & { ok: boolean }): DoctorFailure[] {
  const failures: DoctorFailure[] = [];
  const add = (detail: string, fix: Command | null) =>
    failures.push({ check: "project", detail: `${worker}: ${sentence(detail)}`, fix });

  // Composing a declared peer is not a choice: the Worker does not boot without it.
  for (const entry of checks.prerequisites.missing) {
    add(
      `${entry.capability} requires ${entry.requires}, so this Worker will not boot`,
      prerequisiteFix(directory, entry.requires),
    );
  }
  for (const drift of checks.config.drift) {
    add(`pithy.config.ts is missing ${drift.capability} options: ${drift.keys.join(", ")}`, upgradeFix(directory));
  }
  for (const binding of checks.bindings.missing) {
    add(
      `${binding.name} (${binding.type}) is missing from wrangler.jsonc in ${binding.envs.join(", ")}`,
      upgradeFix(directory),
    );
  }
  for (const className of checks.bindings.missingExports) {
    add(`${className} is not exported from this Worker's entry, and wrangler.jsonc binds it`, upgradeFix(directory));
  }
  // A decline is the adopter's own line in pithy.config.ts. Every refusal of one is an edit to it.
  const declines = checks.bindings.declinedBindings;
  if (declines.state === "invalid") {
    add(`declinedBindings in pithy.config.ts cannot be read. ${declines.problem}`, null);
  } else {
    for (const decline of declines.declines) {
      if (decline.state === "required") {
        add(
          `${decline.name} is declined in pithy.config.ts, and ${decline.capability} requires it. Remove the line`,
          null,
        );
      } else if (decline.state === "undeclinable") {
        add(
          `${decline.name} (${decline.type}) is declined in pithy.config.ts, and this kind cannot be. ${undeclinableReason(decline.type)} Remove the line`,
          null,
        );
      }
    }
  }
  failures.push(...devMigrationFailures(worker, checks));
  // Which capability resolves an entitlement is the adopter's decision, so no `fix` is named for it. The example
  // the sentence offers is the text report's, from the same builder, so it runs as written (#711).
  const gap = checks.entitlements.gap;
  if (gap.state === "unavailable") {
    add("its source would not scan for entitlement gates, so none was checked", null);
  } else if (gap.gates.length > 0) {
    add(
      `routes gate on an entitlement nothing composed resolves: ${gap.gates.join(", ")}. ${providerExample(directory)}`,
      null,
    );
  }
  if (!checks.ok && failures.length === 0)
    add(`one of its checks failed. Run ${pithyCommand("doctor")} for the lines`, null);
  return failures;
}

/** `dev`'s migrations: the one environment whose answer gates (see `MigrationHealth.ok`). */
function devMigrationFailures(worker: string, checks: WorkerChecks): DoctorFailure[] {
  if (checks.migrations.ok) return [];
  const failures: DoctorFailure[] = [];
  const add = (detail: string, fix: Command | null) =>
    failures.push({ check: "project", detail: `${worker}: ${sentence(detail)}`, fix });
  const local = checks.migrations.environments.find((entry) => entry.env === LOCAL_ENVIRONMENT);
  if (local?.state !== "checked" || local.ledger.state === "unavailable") {
    add("dev's migrations could not be checked", null);
    return failures;
  }
  const counted = local.ledger.state === "read" ? local.ledger : local.ledger.counted;
  if (counted.pending > 0) add(`${counted.pending} pending in dev`, migrationFix(local, []));
  // Wiping the local store is the remedy, and an agent does not delete a developer's local data unasked.
  if (counted.undeclared.length > 0) add(`dev: ${describeUndeclared(counted.undeclared)}`, null);
  if (local.ledger.state === "partial") {
    const named = local.ledger.unreadable.map((target) => `${target.binding} (${target.database})`).join(", ");
    add(`dev could not read ${named}`, null);
  }
  return failures;
}

/** The project health block's failures: the project-wide checks, then each Worker's. */
function healthFailures(health: ProjectHealth): DoctorFailure[] {
  const failures: DoctorFailure[] = [];
  const add = (detail: string, fix: Command | null) =>
    failures.push({ check: "project", detail: sentence(detail), fix });

  // Someone else's package: reinstalling it is the remedy, and that is the package manager's.
  for (const fault of health.manifests.faults)
    add(`${fault.package} has a pithy.manifest.json that cannot be used: ${fault.reason}`, null);
  // `pithy add` is the one state it is for: composed, and installed nowhere. Re-running it is safe on the
  // half already done — a registration already in the config is left as written.
  for (const entry of health.capabilityReach.unreachable) {
    add(
      `${entry.capability} is composed by ${entry.workers.join(", ")}, and ${entry.package} is not installed`,
      capabilityReachFix(entry),
    );
  }
  // Repointing is `pithy provision`, and repointing before the rows are carried across empties the binding.
  // The report's own lines walk a person through the carry, so no command is named here.
  const scope = health.bindingScope;
  for (const entry of scope.split) {
    for (const stale of entry.stale.filter(isFixable)) {
      add(
        `${stale.worker} binds ${entry.binding} to ${stale.name} in ${stale.env}, and the project's one ${entry.kind} is ${entry.expected}. Carry the data across, then provision ${stale.env}`,
        null,
      );
    }
  }
  for (const entry of scope.divergent) {
    const ids = repointableIds(entry);
    if (ids.length > 1) {
      add(
        `${entry.binding} opens ${ids.length} different databases across the project. Choose one, carry the data into it, then provision`,
        null,
      );
    }
  }
  if (scope.partial)
    add("part of the project's shared bindings could not be read, so the comparison is incomplete", null);

  for (const worker of health.workers) {
    if (worker.state === "unavailable") {
      add(`${worker.worker} could not be checked: its pithy.config.ts or wrangler.jsonc would not read`, null);
      continue;
    }
    failures.push(...workerFailures(worker.worker, worker.directory, worker));
  }
  if (!health.ok && failures.length === 0)
    add(`project health failed. Run ${pithyCommand("doctor")} for the lines`, null);
  return failures;
}

/**
 * Every check that fails the exit, in report order, each with its `fix`. `doctorExitCode` is whether this is
 * empty, so each branch is the gate itself: the first comment above it is why that check may fail CI, and the
 * last is why its `fix` is the command it is, or none.
 */
export function doctorFailures(report: DoctorReport): DoctorFailure[] {
  const failures: DoctorFailure[] = [];
  const add = (check: DoctorCheck, detail: string, fix: Command | null) =>
    failures.push({ check, detail: sentence(detail), fix });

  // A config that would not load: dependencies not installed, or a syntax error. The package manager's, or an edit.
  if (report.projectLoadError) add("project", `pithy.config.ts would not load. ${report.projectLoadError}`, null);

  // Configured-but-broken credentials are drift worth gating CI on. Absent ones are not: a project that has not
  // been provisioned yet is a legitimate state, and failing it would make `doctor` useless before setup.
  // `not_checked` is the same standard once more and the clearest case of it — the check did not run, so it
  // established nothing, and a caller who asked for no network did not ask for a red exit (#218). `probe_failed`
  // joins them on the same standard (#371): the probe threw, so it established nothing — and a credentials file
  // that will not parse is not a credential this project has been shown to lack.
  // No command fixes one: a token is minted in the dashboard, and an account id is an edit.
  const cloudflare = report.cloudflare.state;
  if (
    cloudflare !== "ok" &&
    cloudflare !== "unconfigured" &&
    cloudflare !== "not_checked" &&
    cloudflare !== "probe_failed"
  ) {
    add("cloudflare", `Cloudflare: ${describeCloudflareAccess(report.cloudflare)}`, null);
  }

  // Listed positively, never as "anything but ok": only a fault this project's own config or wiring positively
  // establishes may gate CI. `unconfigured` (no name yet) and `could-not-check` (the wiring would not read)
  // establish nothing, and failing on either would break every run in an unprovisioned project. `invalid` meets
  // the same standard the other two do — the name is set, and no Cloudflare namespace can carry it, which is why
  // every other command already hard-fails on it. `drifted` and `orphaned` now meet it too, which they did not
  // always: `drifted` used to fire on any one declared name that merely had Pithy's shape, so an adopter's
  // pre-existing `myapp-prod-db` — the ordinary Cloudflare convention — turned a green CI red on the adoption
  // path. Both are evidence-backed now. `drifted` is a wholesale contradiction between this repo's own config
  // and its own wiring, checkable from files alone; `orphaned` is Pithy's own `pithy_migrations_owner` stamp
  // naming another project. A name that only *looks* like ours establishes nothing and no longer reaches either.
  // A `null` check is the same standard once more: no readable config means nothing was established about any
  // name, and `doctor` outside a project — to read the CLI version, the shell, the alias — must exit 0.
  // Each is a decision about a name that is stable forever once anything is provisioned, so none has a command.
  const name = report.projectName;
  if (name && (name.state === "invalid" || name.state === "drifted" || name.state === "orphaned")) {
    add("projectName", `Project name: ${describeProjectName(name)}`, null);
  }

  // Same standard once more, and it is met from local files alone: a Worker's directory and its own
  // wrangler.jsonc contradict each other about which Worker this is, or a stanza names a script a capability's
  // own host Worker already deploys under (#580) — `drifted` covers both. Nothing is inferred about the account,
  // and `could-not-check` establishes nothing, so only `drifted` gates. The convention note this check also
  // carries is deliberately not here: a Worker's name is the adopter's, so being on wrangler's suffix is a
  // report line, never a reason to exit 1.
  // Both are edits: the directory has already moved and `pithy worker rename` refuses a destination that exists,
  // and a reserved name needs a new name, which is a choice.
  const names = report.workerNames;
  if (names?.state === "drifted") {
    for (const mismatch of names.mismatches)
      add("workerNames", `${mismatch.worker} ${describeWorkerName(mismatch)}`, null);
    for (const clash of names.reserved)
      add("workerNames", `${clash.worker} in ${clash.env} ${describeReservedWorkerName(clash)}`, null);
  }

  // The same standard, met the same way, and there is no day-one state to spare here either: a project that
  // declares nothing has nothing to report, and one that declares self-administration while a stanza it deploys
  // from binds no SELF is a contradiction between its own two files. The consequence is the reason it gates — a
  // 522 at runtime, which reads as somebody else's outage — and the remedy is the `pithy provision` that was
  // going to be run anyway. `could-not-check` establishes nothing.
  // For production that provision needs a person's `--confirm` phrase, so it names none.
  if (report.selfBinding?.state === "unbound") {
    for (const entry of report.selfBinding.missing) {
      add(
        "selfBinding",
        `${entry.worker}: ${describeSelfBinding(entry)}`,
        provisionFixCommand(entry.env, report.productionEnvironments),
      );
    }
  }

  // A namespace in the feature range is one `provision` and `deploy` refuse, established by the files (#643).
  // The id is the adopter's to choose below the range, so no command is named.
  if (report.featureRatelimitIds?.state === "reserved") {
    for (const finding of report.featureRatelimitIds.findings) add("featureRatelimitIds", finding, null);
  }

  // Same standard again, and met the same way: the root config and a Worker's own wrangler.jsonc contradict each
  // other about which environments this project has. Nothing about the account is inferred — an orphan is
  // established by ids the checkout already commits — and `could-not-check` establishes nothing, so only
  // `drifted` gates.
  // No command renames a stanza or a declaration; the sentence names which edit.
  const environments = report.environments;
  if (environments?.state === "drifted") {
    for (const drift of environments.drift) {
      add("environments", `${drift.worker}: ${describeEnvironmentDrift(drift, environments.declared)}`, null);
    }
  }

  // And the same standard applied to the same declaration one level deeper (#548): a Worker's `pithy.config.ts`
  // throws when it is composed for a declared environment. Established from the checkout's own files, with no
  // account reached and nothing inferred — and there is no day-one state here to spare, because a freshly
  // scaffolded project composes in every environment it declares. Every command that composes that environment
  // fails the same way, so a green CI over it would be the lie.
  // The config's own refusal is the remedy, and it is an edit to that config.
  for (const { environment, reason } of report.environmentConfigs?.unresolved ?? []) {
    add("environmentConfigs", `${environment}: ${reason}`, null);
  }

  // The same standard, and two of the three origin faults meet it. `workers-dev-open` is a Worker serving a live
  // origin its own config does not name, established from that config alone — and it is the security half: on
  // that origin the CSRF gate refuses the requests that establish who you are, and nothing bound to the hostname
  // applies. `unserved-origin` is the mirror image and the harder failure: the config names an origin and
  // nothing in it serves that host, so the Worker answers nowhere — which is the state this command's own
  // `workers_dev` remedy used to produce, then report as healthy (#264). Both are established from the project's
  // own files. `no-origin` is the state every freshly scaffolded project is in before it has a domain, which is
  // legitimate and universal; failing it would turn `pithy doctor` red on day one for everyone and teach them to
  // stop reading it. It is reported, loudly, and `pithy deploy` is what refuses it — the moment it stops being
  // hypothetical.
  // `pithy worker sync` is the fix where a declaration names the origin; every other fault is an edit.
  for (const drift of report.origins?.drift ?? []) {
    if (drift.fault !== "no-origin") add("origins", describeOriginDrift(drift), originDriftFix(drift));
  }

  // The same standard, and **both** faults meet it — there is no day-one state here to spare. A project that
  // declares no Workflows has no drift to report; one that declares them and has not synced is a contradiction
  // between its own two files, checkable offline, and the only fault in this report whose consequence is nothing
  // happening at all: the cron never fires and nothing anywhere says so (#267). An unwritable declaration is the
  // same standard once more — the declaration itself is what no command can act on. `could-not-check`
  // establishes nothing and carries no drift, so it never reaches here.
  for (const drift of report.workflows?.drift ?? [])
    add("workflows", describeWorkflowDrift(drift), workflowDriftFix(drift));

  // The same standard, met the way `Settings:` meets it rather than the way the file checks do (#678): the fault
  // is established by a **database that answered**, so it is the finding that gates and never the state. A
  // provisioned `pithy_support_search` with no triggers is the only fault in this report whose symptom is that
  // search silently under-returns — every message stored, none indexed, nothing logged — and the remedy is the
  // `pithy support provision` an upgrade was going to run anyway. A read that was skipped or threw contributes
  // no drift, so an offline run cannot fail here.
  if (report.supportSearchTriggers?.state === "findings") {
    const before = failures.length;
    for (const answer of report.supportSearchTriggers.environments) {
      const fix = supportSearchFix(answer);
      if (fix === null) continue;
      const [line] = describeSupportSearchTriggers({ state: "findings", environments: [answer] });
      add("supportSearchTriggers", `${answer.worker}: ${line ?? answer.state}`, fix);
    }
    // The state gates whatever it carries, so a `findings` with no answer this names still gets its entry.
    if (failures.length === before)
      add("supportSearchTriggers", `Support search has findings. Run ${pithyCommand("doctor")} for the lines`, null);
  }

  // And once more, on a file rather than a config. A `dev.json` that will not parse or names no user is a fault
  // this machine's own disk establishes: the file is there, and nothing will ever read anything out of it.
  // `absent` is the documented default — no file, no session, magic links only — so it never gates, and CI
  // (which has no `dev.json` at all) is therefore never touched by this check. The audience is the developer
  // whose dev login stopped working, which is the audience the whole check exists for.
  // No command writes `dev.json`; the sentence says what it must say.
  const preferences = report.devPreferences;
  if (preferences && (preferences.state === "unparseable" || preferences.state === "no-user")) {
    add("devPreferences", `dev.json: ${describeDevPreferences(preferences)}`, null);
  }

  // The same standard as everything above it, and **both tiers meet it** (#411). A local finding is established
  // from the project's own config through the capability's own schema. An account finding is established from an
  // account that answered — which is exactly why the list is what gates and the tier's state is not: an account
  // nobody reached contributes no findings, so a run that skipped it cannot fail here. `could-not-check` and
  // `unchecked` establish nothing and never reach this line.
  // The `fix` is the capability's own, where its check named one; an older capability's finding carries none.
  // It arrives through the capability's `SettingsFinding` schema as a string, so it is the one `fix` here no type
  // holds to the builder: the capability built it with its own, and `failures.test.ts` runs it against the tree.
  for (const finding of report.settings?.findings ?? []) {
    failures.push({ check: "settings", detail: sentence(describeSettingsFinding(finding)), fix: finding.fix ?? null });
  }

  if (report.project && !report.project.health.ok) failures.push(...healthFailures(report.project.health));
  return failures;
}
