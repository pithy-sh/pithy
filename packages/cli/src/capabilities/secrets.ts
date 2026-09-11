// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { isSecretsCapability } from "@pithy-sh/secrets/src/capability";
import { type AuditResult, auditSecrets, passesPromoteGate } from "@pithy-sh/secrets/src/cli/audit";
import {
  dispatchSecretWrite,
  environmentsWrittenBeforeFailure,
  type SecretDispatcher,
} from "@pithy-sh/secrets/src/cli/dispatch";
import { validateSecretValue } from "@pithy-sh/secrets/src/cli/validate";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/masterKeyBinding";
import { parseKeyedSecretName } from "@pithy-sh/secrets/src/keyspace";
import type { SecretRegistry, SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { aggregateSecretRegistries } from "@pithy-sh/secrets/src/sharedSecretsStore";
import type { CliAuditEmit } from "../audit/cliAudit";
import { allCapabilities, type WorkerConfig } from "../project/config";
import { type UnresolvedEnvironment, unresolvedLines } from "./secretApplicability";

/** The audit action for a value-touching secret command, by mode. Never carries the secret's value. */
const SECRET_WRITE_ACTION: Record<SecretWriteCommand["mode"], string> = {
  create: "secrets/set",
  update: "secrets/rotated",
  delete: "secrets/removed",
};

/**
 * Discover a Worker's secret registry from its loaded `apps/<name>/pithy.config.ts` (#25's config
 * model) — **every capability's slice, not the secrets capability's own** (#501).
 *
 * `secrets({ registry })` carries one slice: the master key plus whatever the adopter declared beside
 * it. What `auth`, `email`, `payments` and `turnstile` declare lives on *their* capabilities, and a
 * Worker only ever reads the union — `secrets`' `compose` hook aggregates the same slices at startup
 * and backs the shared accessor from the result. So `pithy secrets` reading one slice was reading a
 * different registry from the Worker it configures, and every secret a capability owns was missing.
 *
 * **Missing with no error, which is what made it survive.** `pithy add auth` ends by naming `pithy
 * secrets create auth-session-secret`, and that command answered "not declared in the registry" — an
 * action line pointing at a command that could not be followed, for `auth-session-secret`,
 * `auth-google-credentials`, `auth-github-credentials`, `email-link-signing-key` and
 * `payments-provider-credentials`. Nothing surfaced until a deployed environment needed one, because
 * the capabilities mint their own dev values and `doctor` reads the union already.
 *
 * **Aggregated, not composed.** Running the `compose` hook would not have fixed it: the hook keeps the
 * combined registry in a closure the status surface reads and never writes it back to
 * `secretRegistry`. So this calls the same aggregator the hook calls — one function, one merge rule,
 * and a contradictory redeclaration of one name is refused there rather than resolved differently in
 * two places.
 *
 * The secrets capability is still required, and that refusal is unchanged: it owns the store every
 * write goes to, so a Worker without it has nowhere to put a secret whoever declared it.
 */
export function resolveSecretRegistry(config: WorkerConfig): SecretRegistry {
  const capabilities = allCapabilities(config);
  if (!capabilities.some(isSecretsCapability)) {
    throw new NotFoundError({
      message: "The secrets capability isn't enabled in this worker.",
      action: "Add secrets({ registry }) to the worker's pithy.config.ts capabilities, or pass --worker.",
    });
  }
  return aggregateSecretRegistries(capabilities);
}

/**
 * The brains of `pithy secrets` — pure wiring over the `@pithy-sh/secrets` cores, with the registry
 * and dispatcher injected so it is fully testable. The citty command (`commands/secrets.ts`) handles
 * I/O — value capture, registry discovery, building the live dispatcher — and calls these.
 */

export interface SecretWriteCommand {
  mode: "create" | "update" | "delete";
  name: string;
  /** The raw value for create/update (omitted for delete) — validated client-side here. */
  value?: string;
  /**
   * The environment the operator named with `--env`, or `undefined` when they named none.
   *
   * **Not defaulted, and that is load-bearing.** A missing `--env` on a `global` secret used to be
   * resolved to the canonical environment before this was called, which made *narrow this write to
   * staging* and *say nothing* indistinguishable by the time anything could refuse either.
   * `secretWriteTargets` refuses on exactly that difference, so the absence has to reach it.
   */
  env: ManagedEnvironment | undefined;
  /**
   * Every environment the project declares, from the root `pithy.config.ts` (#241) — the set a `global`
   * secret fans out across, and the one the canonical CF-Secrets-Store write is chosen from.
   *
   * Beside `env` rather than defaulted, because a default would be the silence this replaced: a project
   * declaring `live` would have its shared secrets written to staging and prod and not to `live`, and
   * nothing would say so.
   */
  environments: DeclaredEnvironments | readonly string[];
}

/**
 * **The master key is not a secret `pithy secrets` may touch, in any mode** (#517).
 *
 * It is the value every other secret in an environment is sealed under, and each mode is a different way
 * to lose all of them at once: `create` and `update` replace the `EncryptionConfig` that decrypts every
 * D1 row, orphaning each one with no error naming the cause, and `rm` deletes it, which is the same loss
 * with nothing to put back. Before the write path knew its backend the damage was quieter and no smaller
 * — a master-key-shaped value was written as a versioned envelope into the very D1 the master key opens,
 * so the command reported success over a row no reader could ever use.
 *
 * `ensureMasterKey` creates it, once, when it is absent, and `pithy add secrets` mints the local one.
 * Rotation is a rotation of the `versions` map inside the config, which is why the entry declares
 * `rotatable: false`. There is no operator-supplied value for it, so there is nothing here to route.
 *
 * **Exported because the command asks it before it asks for a value.** {@link runSecretWrite} raises it
 * too — that is the guarantee, since nothing reaches a store without passing through there — but a
 * refusal that arrives after a masked prompt has taken a production credential is a refusal that cost the
 * operator the thing it was protecting. One function, so the two cannot come to two rules.
 */
export function assertNotTheMasterKey(mode: SecretWriteCommand["mode"], name: string): void {
  if (name !== MASTER_KEY_BINDING) return;
  throw new ValidationError({
    message: `Secret '${name}' is the master key every other secret is sealed under.`,
    action:
      "Run pithy secrets provision, which creates it when it is absent. Replacing it makes every secret in that environment unreadable.",
    detail: `${mode} '${name}': refused — the master key is created by provisioning, never written by hand`,
  });
}

/**
 * Validate a value client-side (the authoritative A2 check) and dispatch the write to the manager
 * Workflow(s). The registry lookup gives the routing facts (backend, scope) and the schema; an
 * undeclared secret is rejected before anything is sent. Returns the environments written.
 *
 * Audited on success and on failure — `secrets/set` (create), `secrets/rotated` (update), or
 * `secrets/removed` (delete) — recording only the secret's **name** and the environments it reached.
 * The value itself, and anything derived from it, never appears in an audit event: that is the one
 * hard rule of a secrets trail.
 */
export async function runSecretWrite(
  registry: SecretRegistry,
  dispatcher: SecretDispatcher,
  command: SecretWriteCommand,
  audit: CliAuditEmit = async () => {},
): Promise<ManagedEnvironment[]> {
  const entry = registry[command.name];
  if (!entry) {
    throw new NotFoundError({
      message: `Secret '${command.name}' is not declared in the registry.`,
      action: "Add it to your secret registry, then run this again.",
    });
  }

  assertNotTheMasterKey(command.mode, command.name);

  // A keyspace has no single value to write, and a write under its bare name would land somewhere no
  // member read ever looks. Its members belong to the app that mints them, which writes them in-worker.
  if (entry.keyed) {
    throw new ValidationError({
      message: `Secret '${command.name}' is a keyspace, not a secret.`,
      action: "Its members are written by the application that owns them, one key at a time.",
    });
  }

  let value: string | undefined;
  if (command.mode !== "delete") {
    if (command.value === undefined || command.value === "") {
      throw new ValidationError({ message: `A value is required to ${command.mode} '${command.name}'.` });
    }
    value = validateSecretValue(entry, command.name, command.value);
  }

  const action = SECRET_WRITE_ACTION[command.mode];
  try {
    const targets = await dispatchSecretWrite(
      dispatcher,
      {
        mode: command.mode,
        name: command.name,
        backend: entry.backend,
        scope: entry.scope,
        // The third routing fact, and the only one that decides what the value is wrapped in: a
        // `bootstrap` secret's destination holds the value, because its reader runs before the decoder
        // exists. Read off the same entry as the other two, never re-derived downstream (#517).
        bootstrap: entry.bootstrap === true,
        rotatable: entry.rotatable,
        valueType: entry.valueType,
        value,
        requested: command.env,
      },
      command.environments,
    );
    await audit({
      action,
      outcome: "success",
      severity: "warning",
      resourceType: "secret",
      resourceId: command.name,
      // The backend, because a value's destination is the fact this trail could not answer (#517). Two
      // secrets with the same name in the same environment land in different stores, and "written to
      // staging" said the same thing about both — including about the writes that landed in the wrong one.
      metadata: { name: command.name, backend: entry.backend, environments: targets },
    });
    return targets;
  } catch (error) {
    // **The environments it reached before it failed, not none of them.** This recorded the name alone,
    // so a `global` fan-out that half-completed left a trail saying a write failed and nothing saying
    // which environments now hold the new value — for `pithy secrets rm`, which environments no longer
    // hold a live key. A refusal reaches this with an empty list, which is true: nothing was sent.
    await audit({
      action,
      outcome: "failure",
      severity: "warning",
      resourceType: "secret",
      resourceId: command.name,
      metadata: { name: command.name, backend: entry.backend, environments: environmentsWrittenBeforeFailure(error) },
    });
    throw error;
  }
}

/**
 * **What a finished write changed — which is not always the environments it was dispatched to** (#517).
 *
 * `secretWriteTargets` answers *where does this write go*, and for a `global` + `cf-secrets-store` secret
 * the answer is one environment: the canonical one, whose manager performs the single account-level
 * write. That is the right dispatch answer and the wrong report. A Secrets Store entry is
 * `<project>-global-<secret>`, flat and account-wide, and **every** environment's stanza binds it — so
 * `pithy secrets update payments-provider-credentials` printed `written to prod` over a change that
 * replaced the credential staging and every other environment reads too. An operator who read that line
 * and then went to update staging separately was reading a report of a fan-out that had already happened.
 *
 * The other three cells are unchanged, because for them the dispatch answer *is* the effect: an
 * `environment` secret has one entry or one row per environment, and a `global` + `d1` secret is a real
 * fan-out that writes each environment's database in turn.
 *
 * One producer for the sentence and the `--json` line, so the two cannot say different things about one
 * act — which is the shape of the defect this issue has produced four times in other places.
 */
export interface SecretWriteEffect {
  /** Every environment now reading the new value. The dispatch targets, widened where they understate. */
  environments: ManagedEnvironment[];
  /**
   * Whether what changed is **one account-level Secrets Store entry** rather than a per-environment
   * value. It is what makes the sentence able to say *one entry, read by these* rather than listing
   * environments as though each held a copy.
   */
  accountEntry: boolean;
}

/**
 * Read the effect of a write off the registry entry it was resolved from, the dispatch targets, and the
 * project's declared set. Pure — the report and the `--json` line both call it.
 *
 * An unknown name (nothing in the registry) reports the targets verbatim: `runSecretWrite` refuses one
 * before anything is dispatched, so there is no write for this to describe and nothing to widen.
 */
export function secretWriteEffect(
  entry: SecretRegistryEntry | undefined,
  targets: readonly ManagedEnvironment[],
  declared: DeclaredEnvironments | readonly string[],
): SecretWriteEffect {
  if (entry?.backend === "cf-secrets-store" && entry.scope === "global") {
    return { environments: [...declared], accountEntry: true };
  }
  return { environments: [...targets], accountEntry: false };
}

/**
 * The one line an operator reads when a write lands: what changed, and where it is read.
 *
 * `written to` / `removed from` stays the verb for a per-environment value. A `global` store entry gets
 * its own clause because the count is the fact: **one** entry, however many stanzas bind it.
 */
export function secretWriteReportLine(
  name: string,
  mode: SecretWriteCommand["mode"],
  effect: SecretWriteEffect,
): string {
  const verb = mode === "delete" ? "removed from" : "written to";
  const where = effect.environments.join(", ");
  return effect.accountEntry ? `${name} ${verb} one account entry, read by ${where}.` : `${name} ${verb} ${where}.`;
}

/** One row of `pithy secrets ls` — rendered for the terminal, structured for `--json`. */
export interface SecretListRow {
  /** The registry name, which is also the binding and the `.dev.vars` variable name. */
  name: string;
  /**
   * The second column, and the same string on both surfaces.
   *
   * Terminal and `--json` render one sentence rather than two, because a report that says two things
   * about one secret is a report somebody eventually quotes the wrong half of. A machine reads
   * {@link applies} and {@link reason} and never this.
   */
  description: string;
  /** Whether this project's configuration can reach the secret at all. `true` for almost every row. */
  applies: boolean;
  /** Why it cannot, when it cannot — the configuration's own reason, never prose about it. */
  reason?: string;
}

/**
 * **The `pithy secrets ls` rows: every declared secret, with what the configuration says about it (#541).**
 *
 * `ls` listed what a composed capability *declares*, so a project running two OAuth providers saw four
 * credentials and a project that had declined its attachment bucket saw the credential for it. The list
 * reads as a checklist, and a checklist that cannot distinguish *not yet done* from *will never apply*
 * re-raises settled questions on every run.
 *
 * **Hidden, not marked (#552).** This listing reads as a checklist of what a project has to set, and a
 * line saying *not applicable* is still a line on that checklist — it re-raises a settled question every
 * run, which is the whole complaint #541 opened with. A project running Google and GitHub does not have
 * four OAuth credentials to think about; it has two, and the other two are not its business.
 *
 * The first cut marked them instead, arguing that `ls` is an inventory and its job is to be complete.
 * That argument is not wrong about inventories and it was the wrong thing to optimize: nobody reading
 * this is auditing the kit's declarations, they are working out what to go and set. `--all` is where
 * completeness lives now, and it prints the reason with each hidden name, so *why is apple missing* has
 * an answer that is one flag away rather than absent.
 *
 * **The reason is never lost, only moved.** `--all` renders it in place of the axes — `d1 · environment`
 * says where a value would be stored, and there is no value to store for a secret nothing will read.
 */
export function secretListRows(
  registry: SecretRegistry,
  inapplicable: ReadonlyMap<string, string>,
  all = false,
): SecretListRow[] {
  return Object.entries(registry)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, entry]): SecretListRow[] => {
      const reason = inapplicable.get(name);
      if (reason !== undefined) {
        if (!all) return [];
        return [{ name, description: `not applicable — ${reason}`, applies: false, reason }];
      }
      // A keyspace is marked, because it is the one entry an operator must not try to set: its members
      // are written per key by the application that mints them.
      const axes = `${entry.backend} · ${entry.scope}${entry.rotatable ? " · rotatable" : ""}${entry.keyed ? " · keyspace" : ""}`;
      return [{ name, description: axes, applies: true }];
    });
}

/**
 * **Which environments this list was decided from, when it was not all of them (#548).**
 *
 * Whether a secret applies is a property of the composition, and a project may hold one per environment.
 * An environment whose `pithy.config.ts` throws produced no composition, so it said nothing about any name
 * and the marks above are drawn from the environments that remain. That is the correct answer — an
 * environment that will not load has a broken config, not a requirement — and it is an answer the operator
 * has to be told the shape of, because a credential only that environment needs may be marked *not
 * applicable* on the strength of the environments that did compose.
 *
 * It used to be worse and quieter: a non-composition contributed *every name in reach*, which under
 * "in reach anywhere wins" beat every real one. The first project to run #541 had a `prod` throwing
 * `Billing is not configured for this environment`, and `ls` printed the unmarked pre-#541 list on every
 * run with nothing saying why. Now it marks, and says what it could not ask.
 *
 * Empty when every environment composed, which is the ordinary case and prints no line at all.
 *
 * The head and the reasons are {@link unresolvedLines}', shared with `pithy doctor` — one fact about one
 * project, worded once. Only the closing sentence is this command's: `ls` **marks** where doctor
 * **filters**, so the risk each one owes its reader is the opposite of the other's.
 */
/**
 * One line saying how many names were left out, so hiding them is never silent (#552).
 *
 * The whole objection to filtering was that a reader cannot tell *nothing applies here* from *the CLI
 * stopped showing me things*. A count answers that in one line and names the flag that expands it, which
 * is the part the marked version was really buying — and it costs one line rather than one per secret.
 *
 * Nothing hidden prints nothing at all, which is the ordinary case for a project that composes what it
 * configures.
 */
export function hiddenNote(hidden: number): string {
  if (hidden === 0) return "";
  const s = hidden === 1 ? "" : "s";
  return `\n\n${hidden} secret${s} this configuration will never read ${hidden === 1 ? "is" : "are"} not listed. pithy secrets ls --all shows ${hidden === 1 ? "it" : "them"}, and why.`;
}

export function unresolvedNote(unresolved: readonly UnresolvedEnvironment[], hidden = 0): string {
  if (unresolved.length === 0) return "";
  // The risk is the same fact either way and the sentence has to name what the reader is looking at.
  // With rows hidden there is nothing "above" to have been marked, and a note pointing at a listing that
  // is not there reads as a bug in the tool rather than a caveat about the answer (#552).
  const risk =
    hidden > 0
      ? "A secret only those environments need may be among the ones not listed. Run pithy doctor."
      : "A secret only those environments need may be marked not applicable above. Run pithy doctor.";
  return ["", ...unresolvedLines(unresolved), risk].join("\n");
}

/** The `ls` / `ls --check` view: the declared names (keyspaces included), the audit, and the gate. */
export interface SecretsListView {
  names: string[];
  audit: AuditResult;
  promotable: boolean;
}

export function runSecretsList(registry: SecretRegistry, presentNames: string[]): SecretsListView {
  const names = Object.keys(registry).sort();
  // A keyspace is expected to have no value of its own, and its stored members are expected to have no
  // registry entry of their own. Counting either would make the promote gate unpassable the day an
  // adopter declares their first per-tenant credential, and would report every tenant as junk.
  const expected = names.filter((name) => !registry[name]?.keyed);
  const present = presentNames.filter((stored) => {
    const member = parseKeyedSecretName(stored);
    return !(member && registry[member.name]?.keyed);
  });
  const audit = auditSecrets(expected, present);
  return { names, audit, promotable: passesPromoteGate(audit) };
}
