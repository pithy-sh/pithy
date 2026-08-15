// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import type { SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import { secretWriteTargets } from "@pithy-sh/secrets/src/cli/writeTargets";
import { SecretRotationUnrecordedError } from "@pithy-sh/secrets/src/error/errors";
import type { SecretRegistry, SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import {
  type RotationSleeper,
  rotateSecretValue,
  type SecretRotationOutcome,
} from "@pithy-sh/secrets/src/rotation/rotateValue";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { CliAuditEmit } from "../audit/cliAudit";

/**
 * **`pithy secrets rotate` — the command side of the rotation core.**
 *
 * The core (`@pithy-sh/secrets`' `rotateSecretValue`) decides *what happened*; this decides what the
 * operator reads, what the trail records, and what the shell gets back. They are split because a state and
 * the sentence describing it must have one producer each — two would let a partial run be phrased as a
 * complete one, which is the shape #321 and #324 each produced once already.
 *
 * ## Three things this file is responsible for
 *
 * - **A line per secret, never a summary.** {@link rotationReportLines} renders from the outcome and only
 *   from the outcome, so there is no path by which "rotated" is printed over an environment that did not
 *   take the value.
 * - **The unrecorded state, made unmissable.** {@link unrecordedFailure} turns it into a
 *   `secrets/rotation_unrecorded` — its own code, its own exit status, and an action line composed from
 *   the declaration, so the operator is told which console to open rather than that something failed.
 * - **An exit code that distinguishes it.** {@link EXIT_ROLLED_NOT_RECORDED}.
 *
 * ## And one thing it deliberately does not do
 *
 * **It never surfaces the value.** Not on a success, not on a failure, not on the failure where the value
 * is about to be lost. The argument, in full, is in `docs/commands/secrets.md`; in short, a live
 * credential written to a terminal is in scrollback, in the CI log, and in whatever recorded the session,
 * permanently — while a rolled-and-unrecorded credential is an outage whose remedy the declaration can
 * name. The core has no field that could carry a value out, so this is structural rather than a habit.
 */

/**
 * The exit status for **rolled at the issuer, not recorded**.
 *
 * Distinct from `1`, which every ordinary failure uses, because the two need different reactions and a
 * script cannot tell them apart from a message. `1` means the previous credential is still live and the
 * command can be run again. `3` means it is not, and nothing automated will fix it.
 *
 * `2` is left alone: shells and citty both use it for usage errors, and a status that could mean either
 * "you typed it wrong" or "a production credential is dead" is no signal at all.
 */
export const EXIT_ROLLED_NOT_RECORDED = 3;

/** What the command asks for: one secret, in one environment (or none, for a `global` secret). */
export interface SecretRotateCommand {
  /** The registry name. */
  name: string;
  /** The environment the operator named with `--env`, or `undefined`. Not defaulted — see `SecretWriteCommand`. */
  env: ManagedEnvironment | undefined;
  /** Every environment the project declares. What a `global` secret fans out across. */
  environments: DeclaredEnvironments | readonly string[];
  /** Resolve the declaration and report what would happen. Calls nothing, writes nothing. */
  dryRun?: boolean;
  /** Store attempts per environment. Defaults to the core's 3. Never a re-roll. */
  attempts?: number;
  /** Injected in tests so a retry costs no real time. */
  sleep?: RotationSleeper;
}

/** The entry, or the same refusal `runSecretWrite` gives for a name the registry has never heard of. */
function requireEntry(registry: SecretRegistry, name: string): SecretRegistryEntry {
  const entry = registry[name];
  if (!entry) {
    throw new NotFoundError({
      message: `Secret '${name}' is not declared in the registry.`,
      action: "Add it to your secret registry, then run this again.",
    });
  }
  return entry;
}

/**
 * Rotate one secret and record what happened.
 *
 * **The targets come from `secretWriteTargets`**, the same rule `pithy secrets create` and
 * `mintDeclaredSecrets` ask, so a rotation cannot put a value somewhere an update would not — and a
 * `global` secret narrowed with `--env` is refused here for the same reason it is there, before anything
 * is rolled.
 *
 * The audit line is `secrets/rotated`, matching what `pithy secrets update` already emits for the same
 * act, and it carries the name and the environments and nothing else. `unchanged` records nothing: a
 * trail that logs a rotation for a secret nothing touched is a trail that cannot be read.
 */
export async function runSecretRotation(
  registry: SecretRegistry,
  dispatcher: SecretDispatcher,
  command: SecretRotateCommand,
  audit: CliAuditEmit = async () => {},
): Promise<SecretRotationOutcome> {
  const entry = requireEntry(registry, command.name);
  // A keyspace has no single value; the core says so too, but asking the routing rule first would raise a
  // less useful refusal about environments. Left to the core, which names the right thing.
  const targets = entry.keyed
    ? []
    : secretWriteTargets({
        name: command.name,
        backend: entry.backend,
        scope: entry.scope,
        mode: "update",
        requested: command.env,
        declared: command.environments,
      });

  const outcome = await rotateSecretValue({
    name: command.name,
    entry,
    targets,
    store: ({ env, value }) =>
      dispatcher.dispatch({
        env,
        mode: "update",
        name: command.name,
        value,
        valueType: entry.valueType,
        rotatable: entry.rotatable,
      }),
    ...(command.attempts !== undefined ? { attempts: command.attempts } : {}),
    ...(command.sleep !== undefined ? { sleep: command.sleep } : {}),
    ...(command.dryRun !== undefined ? { dryRun: command.dryRun } : {}),
  });

  if (outcome.status !== "unchanged") {
    await audit({
      action: "secrets/rotated",
      outcome: outcome.status === "rotated" ? "success" : "failure",
      // The unrecorded state is the one administrative act in this command that leaves a system broken,
      // so it is the one that reads as `critical` in a trail somebody scans after an incident.
      severity: outcome.status === "unrecorded" ? "critical" : "warning",
      resourceType: "secret",
      resourceId: command.name,
      metadata: {
        name: command.name,
        environments: outcome.recorded,
        rotation: outcome.kind,
        rolled: outcome.rolled,
        // The trail is what an incident review reads, and *was rolled* against *may have been rolled* is
        // the fact that review turns on. Recorded rather than left to be inferred from the absence of
        // environments, which is the same information only if somebody knows to look for it.
        ...(outcome.rollFailed === undefined ? {} : { rollFailed: outcome.rollFailed }),
        ...(outcome.stranded.length > 0 ? { stranded: outcome.stranded } : {}),
      },
    });
  }
  return outcome;
}

/** The issuer a `provider` or `manual` secret names, for a sentence that has to say where. */
function issuerOf(entry: SecretRegistryEntry): string {
  return entry.rotation !== undefined && entry.rotation.kind !== "local" ? entry.rotation.issuer : "its issuer";
}

/** The page a `provider` or `manual` secret names, when it names one. */
function documentationOf(entry: SecretRegistryEntry): string | undefined {
  return entry.rotation !== undefined && entry.rotation.kind !== "local" ? entry.rotation.documentation : undefined;
}

/** `pithy secrets update <NAME> --env <env>` — the command that records a value a human obtained. */
function updateCommand(name: string, env: ManagedEnvironment | undefined): string {
  return `pithy secrets update ${name}${env === undefined ? "" : ` --env ${env}`}`;
}

/**
 * The lines an operator reads, one per outcome, on stdout.
 *
 * **The word "rotated" appears only where a new value is stored**, and never on a run that rolled and
 * lost it. Everything else is said plainly: what was replaced, where it landed, and where it did not.
 */
export function rotationReportLines(
  entry: SecretRegistryEntry,
  outcome: SecretRotationOutcome,
  env: ManagedEnvironment | undefined,
): string[] {
  const issuer = issuerOf(entry);
  const documentation = documentationOf(entry);
  switch (outcome.status) {
    case "rotated":
      return [
        outcome.rolled
          ? `${outcome.name} rolled at ${issuer} and recorded in ${outcome.recorded.join(", ")}.`
          : `${outcome.name} rotated in ${outcome.recorded.join(", ")}.`,
      ];
    case "unchanged":
      if (outcome.reason === "manual") {
        return [
          `${outcome.name} is replaced by a human at ${issuer}. Nothing was called.`,
          ...(documentation === undefined ? [] : [documentation]),
          `Record the new value with ${updateCommand(outcome.name, env)}.`,
        ];
      }
      return [
        outcome.kind === "provider"
          ? `${outcome.name} would be rolled at ${issuer}, then written to ${outcome.stranded.join(", ")}.`
          : `${outcome.name} would be minted here, then written to ${outcome.stranded.join(", ")}.`,
      ];
    case "unrecorded":
      // **The rotator threw, so `rolled` is a guess and the line says so.** The call reached the issuer and
      // the answer did not come back; nothing here can tell a request that never landed from a response
      // that was lost, and claiming either is wrong half the time about the fact being acted on.
      if (outcome.rollFailed) {
        return [
          `${outcome.name} may have been rolled at ${issuer}. Nothing was recorded.`,
          `Check ${issuer} before running this again.`,
        ];
      }
      return [
        outcome.recorded.length > 0
          ? `${outcome.name} rolled at ${issuer} and recorded in ${outcome.recorded.join(", ")}.`
          : `${outcome.name} rolled at ${issuer} and recorded nowhere.`,
        `${outcome.stranded.join(", ")} still holds a credential ${issuer} has retired.`,
      ];
    case "failed":
      return outcome.recorded.length > 0
        ? [
            `${outcome.name} rotated in ${outcome.recorded.join(", ")}.`,
            `${outcome.stranded.join(", ")} refused the write, and still holds the previous value.`,
          ]
        : [`${outcome.name} was not rotated. Nothing was rolled and nothing was written.`];
  }
}

/**
 * The unrecorded state as a throwable failure: its own code, the secret and the issuer in `message`, and
 * an action line that names the console and the command.
 *
 * **The action is the whole point of the declaration.** #322 put an issuer and a documentation URL on
 * every non-`local` rotation precisely so this sentence could be written from the registry rather than
 * guessed — the operator holding a dead credential should not also have to work out whose console it is.
 *
 * The `cause` is attached but never rendered into `message`: what the store said belongs in `detail`,
 * which the HTTP codec strips, and the operator's own remedy belongs in front of them.
 */
export function unrecordedFailure(
  entry: SecretRegistryEntry,
  outcome: SecretRotationOutcome,
  env: ManagedEnvironment | undefined,
): SecretRotationUnrecordedError {
  const issuer = issuerOf(entry);
  const documentation = documentationOf(entry);
  const where = outcome.stranded.join(", ");
  const page = documentation === undefined ? "" : ` ${documentation}`;
  // The rotator never answered, so whether the credential moved is unknown — and the remedy starts with
  // finding out, not with rolling again. Rolling again on an issuer that already rolled produces a second
  // orphan; the check is the step that difference costs.
  if (outcome.rollFailed) {
    return new SecretRotationUnrecordedError(
      {
        message: `${outcome.name} may have been rolled at ${issuer}, and nothing was recorded. ${where} may be holding a retired credential.`,
        // Careful about what it claims. The rotator threw, so whether this process ever held the value is
        // itself unknown — "the value is gone" would be a second guess stacked on the first. What is known
        // is that nothing recorded one, and that is what the sentence says.
        action: `Check at ${issuer} whether a new credential was issued. If one was, nothing here recorded it — take the value from ${issuer} and record it with ${updateCommand(outcome.name, env)}. If none was, run this again.${page}`,
        detail: `rotate '${outcome.name}': rotator failed, nothing stored in [${where}] — ${describeCause(outcome.cause)}`,
      },
      { cause: outcome.cause },
    );
  }
  return new SecretRotationUnrecordedError(
    {
      message: `${outcome.name} was rolled at ${issuer} and its new value was not stored. ${where} holds a credential ${issuer} has retired.`,
      // Said outright, because the alternative reading — that the value is sitting somewhere recoverable —
      // is the one an operator will assume, and acting on it wastes the minutes that matter.
      action: `The new value is gone. It existed only in this process, and printing it would leave a live credential in your shell history. Roll it again at ${issuer}, then record it with ${updateCommand(outcome.name, env)}.${page}`,
      detail: `rotate '${outcome.name}': rolled, recorded in [${outcome.recorded.join(", ")}], not recorded in [${where}] after ${outcome.attempts ?? 0} store attempts — ${describeCause(outcome.cause)}`,
    },
    { cause: outcome.cause },
  );
}

/** What ended the store attempt, for `detail` only. Never a value — the store is given one, never asked for one. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return cause === undefined ? "no cause recorded" : String(cause);
}
