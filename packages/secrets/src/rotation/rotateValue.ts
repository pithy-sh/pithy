// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { mintSecretValue } from "../mintValue";
import type { SecretRegistryEntry } from "../registry";
import type { ManagedEnvironment } from "../scope";
import type { OpenRotation, RotationLedger } from "./rotationLedger";

/**
 * **One rotation of one secret's value, built around the failure that cannot be undone.**
 *
 * The failure is `#322`'s, and it is the reason this module is shaped the way it is: *a provider roll
 * succeeds and the store write fails.* The new value exists only in this process, the old one is dead at
 * the issuer, and the Worker holds a credential that no longer works. Nothing downstream can repair that
 * by trying harder, because trying harder at the *roll* produces a third value and loses the second.
 *
 * So the ordering is the design, not a caveat on it:
 *
 * 1. **Refuse everything refusable before anything is called.** A keyspace, an undeclared rotation, a
 *    `provider` secret with no rotator, the master key — each is answered with nothing rolled and nothing
 *    written. A refusal after a roll would be the worst of both.
 * 2. **Produce the value once.** `local` mints it; `provider` calls the rotator. Exactly one call, and
 *    it is never repeated for any reason.
 * 3. **Store with retries, against that value.** Every attempt writes the same string. A store that
 *    cannot be made to succeed ends the run; it never reaches back for a fresh value.
 *
 * ## What it reports, and why never in aggregate
 *
 * One {@link SecretRotationOutcome}, naming the environments the new value reached and the environments
 * it did not. `unrecorded` is the state above — rolled at the issuer, not recorded — and it is a separate
 * member from `failed` because the operator's next move differs completely: `failed` means the old value
 * is still live and the command can simply be run again, while `unrecorded` means somebody must go to a
 * console **now**. An "all rotated" line printed over that distinction is the shape this refuses.
 *
 * ## What happens to the value when the store will not take it
 *
 * It is discarded, and the run says so. It is not printed, not written to a file, not put in an audit
 * event, and not handed back to the caller — see {@link SecretRotationOutcome}, which has no field that
 * could carry one. That is a decision with a cost, and the cost is named in `docs/commands/secrets.md`
 * beside the alternative: a live production credential in shell scrollback, in a CI log, and in every
 * terminal-recording buffer on the machine is a permanent leak, where a rolled-but-unrecorded credential
 * is an outage with a known remedy the declaration can name — roll again at the issuer by hand, then
 * `pithy secrets update`. The retries above are what make reaching that point rare; the honesty about it
 * is what makes it survivable.
 *
 * ## The attempt is recorded here, and only here
 *
 * A rotation that succeeds and records nothing leaves the secret reporting **overdue forever** — `#379`,
 * which reached production behaviour precisely because the recording lived at a *call site* rather than at
 * the act. So the {@link RotationLedger} is an argument to this function and it is **required**: refuse,
 * open the row, produce once, store with retries, close the row. A third caller inherits the ordering by
 * calling this, and cannot opt out of it by forgetting. `./rotationLedger.ts` holds the seam and the
 * argument for its shape.
 *
 * ## What this does not do, stated rather than implied
 *
 * It does not **verify** the new value against the issuer. `#322` puts a verify step between store and
 * settle, and it belongs there — but no rotator ships in the kit today, so a verification seam nothing
 * implements would be a step that always passes, which is worse than an absent one. The window it would
 * close is real and is written down in the command's page.
 */

export const SecretRotationStatus = z
  .enum(["rotated", "unchanged", "unrecorded", "failed"])
  .describe(
    "How one secret's rotation ended. `rotated` — a new value exists and every target environment holds it. `unchanged` — nothing was called and nothing was written. `unrecorded` — **the issuer rolled and the store did not take the value**, so a live credential is gone and its successor is lost; distinct from `failed` because only this one needs a human in a console now. `failed` — the roll never happened or the store refused before one did, and the previous value is still live.",
  );
export type SecretRotationStatus = z.output<typeof SecretRotationStatus>;

export const SecretRotationUnchangedReason = z
  .enum(["manual", "dry-run"])
  .describe(
    "Why a rotation did nothing. `manual` — the secret declares that only a human in the issuer's console can replace it, so there was nothing to call. `dry-run` — the operator asked what would happen. Both are answers rather than failures, and both exit zero.",
  );
export type SecretRotationUnchangedReason = z.output<typeof SecretRotationUnchangedReason>;

/**
 * What one rotation did. Facts only — the prose belongs to the command, which owns the voice, so a
 * sentence and the state it describes cannot drift apart into two producers.
 *
 * **There is no field for a value, and there must never be one.** That is the structural half of the rule
 * `docs/commands/secrets.md` states in prose: a payload with nowhere to put a secret cannot leak one by
 * a later caller's oversight.
 */
export interface SecretRotationOutcome {
  /** The secret's registry name. */
  name: string;
  /** How it ended. See {@link SecretRotationStatus}. */
  status: SecretRotationStatus;
  /** How the registry says this secret is replaced — `local`, `provider`, or `manual`. */
  kind: "local" | "provider" | "manual";
  /** Whether the issuer's credential was actually rolled. True only for a `provider` rotation that reached its rotator. */
  rolled: boolean;
  /**
   * Whether the **rotator itself** failed, rather than the store after it.
   *
   * The difference is the difference between a true sentence and a false one. A rotator that returned and
   * a store that refused means the credential *was* rolled. A rotator that threw means it *may* have been —
   * the call reached the issuer and the answer did not come back, and no code here can tell a request that
   * never landed from a response that was lost. Both need a human at the issuer; only one of them may be
   * described as *rolled*, and a report that says so of both is wrong half the time about the one fact the
   * operator is acting on.
   */
  rollFailed?: boolean;
  /** The environments this run wrote the new value to, in order, as each write landed. */
  recorded: ManagedEnvironment[];
  /** The environments the new value never reached. Empty on a run that finished. */
  stranded: ManagedEnvironment[];
  /** Why nothing was called, when nothing was. */
  reason?: SecretRotationUnchangedReason;
  /** How many store attempts the failing environment cost, for the report. Absent when nothing was stored. */
  attempts?: number;
  /** What ended the run, for the command to render. Never inspected here, and never carries a value. */
  cause?: unknown;
}

/** Write one value into one environment's store. The caller's dispatcher; this module never writes. */
export type SecretValueStore = (request: { env: ManagedEnvironment; value: string }) => Promise<void>;

/** Wait, between store attempts. Injected so a test spends no real time. */
export type RotationSleeper = (ms: number) => Promise<void>;

/** How many times the store is asked, and how long between asks. */
const DEFAULT_ATTEMPTS = 3;
const BACKOFF_MS = 250;

const defaultSleeper: RotationSleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RotateSecretValueOptions {
  /** The secret's registry name. */
  name: string;
  /** Its registry entry — the declaration every refusal below is read off. */
  entry: SecretRegistryEntry;
  /**
   * Where the new value must land, already decided by `secretWriteTargets`. One environment for an
   * `environment`-scoped secret, every declared one for a `global` secret.
   *
   * Passed in rather than computed, so a rotation and a `pithy secrets update` of the same secret cannot
   * disagree about where its value lives.
   */
  targets: readonly ManagedEnvironment[];
  /** The store write, per environment. Called once per attempt, always with the same value. */
  store: SecretValueStore;
  /**
   * Where the attempt is recorded — opened before the roll, closed with the outcome.
   *
   * **Required, and that is the fix for `#379`.** An optional ledger is one a caller forgets, and the
   * caller that forgot was `pithy secrets rotate`: it dispatched an ordinary `update`, nothing recorded a
   * rotation, and the secret reported overdue permanently. See {@link RotationLedger}.
   */
  ledger: RotationLedger;
  /** Store attempts per environment before the run ends. Defaults to 3. Never a re-roll. */
  attempts?: number;
  /** Injected in tests. Defaults to a real `setTimeout`. */
  sleep?: RotationSleeper;
  /** Resolve the declaration and report what would happen, calling nothing and writing nothing. */
  dryRun?: boolean;
}

/**
 * Refuse a rotation that cannot be performed, **before anything is called**.
 *
 * Every one of these is a fact about the declaration, knowable with no network and no provider contact, so
 * every one of them is answered here rather than by a rotator failing in its own words halfway through.
 * A refusal reaching an operator after a roll would leave a dead credential behind a message about
 * configuration.
 */
function refuseUnrotatable(name: string, entry: SecretRegistryEntry): void {
  if (entry.keyed) {
    throw new ValidationError({
      message: `Secret '${name}' is a keyspace, not a secret.`,
      action: "Its members are rotated one key at a time by the application that owns them.",
      detail: `rotate refused: '${name}' is a keyspace`,
    });
  }
  if (entry.rotation === undefined) {
    throw new ValidationError({
      message: `Secret '${name}' does not declare how it rotates.`,
      action: `Add a rotation to its registry entry, then run this again. Until then, replace it with pithy secrets update ${name}.`,
      detail: `rotate refused: '${name}' declares no rotation`,
    });
  }
  if (entry.rotation.kind === "provider" && entry.rotator === undefined) {
    throw new ValidationError({
      message: `Secret '${name}' rotates by calling ${entry.rotation.issuer}, and this project supplies no rotator for it.`,
      action: `Attach a rotator to its registry entry, or roll it at ${entry.rotation.issuer} by hand and record it with pithy secrets update ${name}.`,
      detail: `rotate refused: '${name}' is rotation.kind provider with no rotator on the registry entry`,
    });
  }
  if (entry.rotation.kind !== "local") return;
  // The master key is `local` and is the one secret this command must not touch. It is not a value in a
  // versioned envelope; it *is* the `EncryptionConfig` every other value is read through, and replacing it
  // here would leave every stored secret sealed under a key nothing holds. It rotates on its own axis —
  // the `versions` map inside itself — driven by the manager's own cron.
  if (entry.bootstrap) {
    throw new ValidationError({
      message: `Secret '${name}' is the key every other secret is read through, so nothing replaces it in place.`,
      action: "It rotates on its own schedule, inside the secrets manager. Nothing here should roll it.",
      detail: `rotate refused: '${name}' is a bootstrap secret; at-rest key rotation owns it`,
    });
  }
  if (entry.devValue === undefined) {
    throw new ValidationError({
      message: `Secret '${name}' is minted from a structure this command cannot produce.`,
      action: `Replace it with pithy secrets update ${name}.`,
      detail: `rotate refused: '${name}' is rotation.kind local with no devValue recipe`,
    });
  }
}

/**
 * Produce the successor value. **The one third-party mutation, and it happens exactly once.**
 *
 * `local` mints it here, from the same `mintSecretValue` that created it, because what the kit can make
 * it can make again. `provider` hands off to the declared rotator, and what comes back may be the only
 * copy of a live credential in existence from the moment it returns.
 */
async function nextValue(options: {
  name: string;
  entry: SecretRegistryEntry;
  env: ManagedEnvironment;
}): Promise<{ value: string; rolled: boolean }> {
  const { entry } = options;
  if (entry.rotation?.kind === "provider" && entry.rotator !== undefined) {
    const result = await entry.rotator.roll({ name: options.name, env: options.env, entry });
    if (typeof result?.newValue !== "string" || result.newValue === "") {
      // A rotator that answers with nothing usable has still, as far as anything here knows, rolled the
      // credential. So this is not a quiet skip: it is the unrecorded state arriving from the other side,
      // and it is raised where the caller classifies it as one.
      throw new ValidationError({
        message: `The rotator for '${options.name}' returned no value.`,
        action: `Check whether ${entry.rotation.issuer} issued a new credential, and record it with pithy secrets update ${options.name}.`,
        detail: `rotator for '${options.name}' resolved without a newValue string`,
      });
    }
    return { value: result.newValue, rolled: true };
  }
  // `local`, and `refuseUnrotatable` has already proved the recipe is there.
  if (entry.devValue === undefined) {
    throw new ValidationError({
      message: `Secret '${options.name}' cannot be minted.`,
      detail: `nextValue reached for '${options.name}' with no devValue — refuseUnrotatable should have caught this`,
    });
  }
  return { value: mintSecretValue(entry.devValue), rolled: false };
}

/**
 * Open the rotation row, and **never let the bookkeeping stop the act**.
 *
 * A ledger that cannot be reached is a gap in a history. A credential that was not replaced because the
 * history could not be written is an unrotated credential, and during the incident that prompted the
 * rotation that is the worse of the two by a wide margin. So a ledger failure is absorbed: the row is
 * simply absent, which is visible as a missing entry and as a `lastRotatedAt` that did not move — the
 * same two signals `#379` itself was found through.
 */
async function openAttempt(ledger: RotationLedger, name: string): Promise<OpenRotation | undefined> {
  try {
    return await ledger.open(name);
  } catch {
    return undefined;
  }
}

/**
 * Close the row, absorbing a ledger failure for the same reason {@link openAttempt} does — and one more:
 * by the time this runs the rotation has happened, and a throw here would take `recorded` and `stranded`
 * with it. Losing the record of what landed is how a recoverable store failure becomes an unrecoverable
 * one.
 */
async function closeAttempt(attempt: OpenRotation | undefined, outcome: SecretRotationOutcome): Promise<void> {
  if (attempt === undefined) return;
  try {
    await attempt.close(outcome);
  } catch {
    // Deliberately absorbed. See above.
  }
}

/**
 * Rotate one secret's value: refuse, open the row, produce once, store with retries, close the row, report
 * per secret.
 *
 * Never throws for a rotation that *happened* and went wrong — that is an outcome, because a throw would
 * take the record of what landed with it, and the record is what makes the remedy safe. It throws only for
 * the refusals above, which happen before anything is called and leave nothing to report — and, because
 * they land before the row is opened, a refused rotation writes no history either.
 */
export async function rotateSecretValue(options: RotateSecretValueOptions): Promise<SecretRotationOutcome> {
  const { name, entry, targets } = options;
  refuseUnrotatable(name, entry);
  // Narrowed by the refusals; restated for the type, which cannot see through a function call.
  const rotation = entry.rotation;
  if (rotation === undefined)
    throw new ValidationError({ message: `Secret '${name}' does not declare how it rotates.` });

  const base: Pick<SecretRotationOutcome, "name" | "kind"> = { name, kind: rotation.kind };

  // A human in a console, and nothing to call. An answer, not a failure — so it exits zero and says where.
  if (rotation.kind === "manual") {
    return { ...base, status: "unchanged", rolled: false, recorded: [], stranded: [], reason: "manual" };
  }
  if (options.dryRun) {
    return { ...base, status: "unchanged", rolled: false, recorded: [], stranded: [...targets], reason: "dry-run" };
  }
  if (targets.length === 0) {
    throw new ValidationError({
      message: `Secret '${name}' has no environment to rotate in.`,
      action: "Declare at least one environment in the root pithy.config.ts, then run this again.",
      detail: `rotate refused: '${name}' resolved to no write targets`,
    });
  }

  // **The line either side of which everything changes.** Above it, a refusal costs nothing. Below it, a
  // credential may already be dead at its issuer, and every remaining step is retryable against one value.
  const first = targets[0];
  if (first === undefined) throw new ValidationError({ message: `Secret '${name}' has no environment to rotate in.` });

  // **Opened here, and not one line later.** Every refusal above has already been answered, so no row is
  // written for a rotation that never started; and the roll is the next thing that happens, so a rotator
  // that never returns still leaves an `in_progress` row naming the secret and who asked.
  const attempt = await openAttempt(options.ledger, name);
  const outcome = await rollAndStore(options, { base, rotation, first });
  await closeAttempt(attempt, outcome);
  return outcome;
}

/**
 * Everything below the irreversible line: produce the value once, then store it with retries.
 *
 * Split out so the ledger bracket in {@link rotateSecretValue} reads as one statement — open, run, close —
 * rather than as a `close` repeated at each of four exits, which is the shape somebody eventually adds a
 * fifth exit to.
 */
async function rollAndStore(
  options: RotateSecretValueOptions,
  context: {
    base: Pick<SecretRotationOutcome, "name" | "kind">;
    rotation: NonNullable<SecretRegistryEntry["rotation"]>;
    first: ManagedEnvironment;
  },
): Promise<SecretRotationOutcome> {
  const { name, entry, targets } = options;
  const { base, rotation, first } = context;
  let produced: { value: string; rolled: boolean };
  try {
    produced = await nextValue({ name, entry, env: first });
  } catch (error) {
    // A `local` mint cannot reach a provider, so nothing was rolled and the old value is untouched. A
    // `provider` rotator that threw may or may not have rolled — and "may have" is the state that needs a
    // human, so it is reported as `unrecorded` rather than guessed into `failed`.
    const rolled = rotation.kind === "provider";
    return {
      ...base,
      status: rolled ? "unrecorded" : "failed",
      rolled,
      // A `local` mint that threw failed here, in this process, and reached nobody — so this is set only
      // for the provider case, where it is what stops the report claiming a roll it cannot confirm.
      ...(rolled ? { rollFailed: true } : {}),
      recorded: [],
      stranded: [...targets],
      cause: error,
    };
  }

  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleeper;
  const recorded: ManagedEnvironment[] = [];
  for (const env of targets) {
    let spent = 0;
    let last: unknown;
    while (spent < attempts) {
      spent += 1;
      try {
        // The same string, every attempt. Reaching back for a fresh value here is the mistake that turns
        // a recoverable store failure into a lost credential, so there is nothing here that could.
        await options.store({ env, value: produced.value });
        last = undefined;
        break;
      } catch (error) {
        last = error;
        if (spent < attempts) await sleep(BACKOFF_MS * 2 ** (spent - 1));
      }
    }
    if (last !== undefined) {
      const stranded = targets.filter((target) => !recorded.includes(target));
      return {
        ...base,
        // Rolled and not recorded *anywhere* is the incident. Rolled and recorded in some environments is
        // the same incident for the rest of them: the issuer's old credential is dead there too, and no
        // command can copy the new one across, because nothing reads a stored value back out.
        status: produced.rolled ? "unrecorded" : "failed",
        rolled: produced.rolled,
        recorded,
        stranded,
        attempts: spent,
        cause: last,
      };
    }
    recorded.push(env);
  }

  return { ...base, status: "rotated", rolled: produced.rolled, recorded, stranded: [] };
}
