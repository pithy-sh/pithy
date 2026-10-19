// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DevSecretValue } from "@pithy-sh/core/src/capability/devSecret";
import { SecretOrigin, SecretRotation } from "@pithy-sh/core/src/capability/secretOrigin";
import { remedy } from "@pithy-sh/core/src/cli/command";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { hash6 } from "@pithy-sh/core/src/naming/resource";
import { z } from "zod";
import {
  SecretBackend,
  type SecretRegistry,
  type SecretRegistryEntry,
  SecretScope,
  SecretValueType,
  unattendedRotation,
} from "../registry";

/**
 * **The schedule the secrets manager rotates on, and the decision one cron tick makes from it (#602).**
 *
 * The manager is a prebuilt Worker: it is bundled with its own registry and never loads the adopter's
 * `pithy.config.ts`. So provisioning reads the project's registry — every capability's slice, aggregated
 * the way a Worker aggregates it — and stamps what the cron needs into the manager's `VALUE_ROTATIONS` var.
 * The manager parses it back here, rebuilds each entry, and checks it with `defineSecretRegistry` again,
 * because a var is external config and the registry's refusals are the whole of what makes an unattended
 * rotation safe.
 *
 * ## What crosses, and what cannot
 *
 * Declarations only: backend, scope, period, overlap, origin, rotation, the mint recipe. A
 * {@link SecretRegistryEntryBase.rotator} is a function and cannot cross into JSON, so a `provider` secret
 * reaches the manager with none — and the cron reports it rather than rotating it, which is what
 * `pithy secrets rotate` does with the same declaration. A Zod `schema` cannot cross either; nothing the cron
 * rotates needs one, since `local` mints only `text`.
 *
 * ## Who rotates a global secret
 *
 * Exactly one manager: the last declared environment's (`docs/NAMING.md`), stamped as `GLOBAL_ENVIRONMENT`.
 * Every other manager answers `not-owner` for a global secret **by construction** — not because its clock
 * says it is not due — so staging can never replace a value production depends on. A manager that was not
 * told owns none. And a global `d1` secret is refused outright, here as at define time: it is a sealed copy
 * in every environment's vault, and one manager binds only its own.
 */

/** One secret as the manager's schedule carries it. Version-free, value-free, and a function cannot reach it. */
export const StampedRotation = z
  .object({
    name: z.string().min(1).describe("The secret's registry name."),
    backend: SecretBackend.describe("Where the value lives, which decides how the manager writes it."),
    scope: SecretScope.describe("Whether the value is one per environment or one for the whole project."),
    rotatable: z.boolean().describe("Whether the secret keeps a previous version while it changes."),
    valueType: SecretValueType.describe("How the value is read. The cron only mints `text`."),
    devValue: DevSecretValue.optional().describe("The mint recipe, for a secret the kit can make another of."),
    origin: SecretOrigin.optional().describe("How the value came to exist."),
    rotation: SecretRotation.optional().describe("How the value is replaced — what the cron does with it."),
    rotateEveryDays: z.number().int().positive().describe("The period, in days, from the registry entry."),
    overlap: z
      .object({
        days: z.number().int().positive().describe("Days a replaced version keeps verifying before it retires."),
        minimumDays: z.number().int().positive().describe("The shortest overlap the secret's owner allows."),
        reencrypt: z
          .array(z.string().min(1).describe("One value sealed under the secret at rest, by name."))
          .optional()
          .describe("What must be re-encrypted under the new version before the old one retires."),
      })
      .optional()
      .describe("The overlap a rotation keeps, from the registry entry."),
  })
  .describe("One secret's unattended-rotation declaration, as provisioning stamps it into the secrets manager.");
export type StampedRotation = z.output<typeof StampedRotation>;

/** The whole schedule, as the `VALUE_ROTATIONS` var carries it. */
export const StampedRotations = z
  .array(StampedRotation)
  .describe("Every secret with a declared period, as the secrets manager's `VALUE_ROTATIONS` var carries them.");

/**
 * The schedule for a registry: every **named** entry that declares `rotateEveryDays`, sorted by name.
 *
 * A keyspace is left out — `defineSecretRegistry` refuses an unattended one, and a keyspace's members are
 * rotated by the application that owns them. Entries that only `report` are included, so the manager's log
 * can say what it chose not to do and why.
 */
export function stampedRotations(registry: SecretRegistry): StampedRotation[] {
  return Object.entries(registry)
    .filter(([, entry]) => entry.rotateEveryDays !== undefined && !entry.keyed)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, entry]) =>
      StampedRotation.parse({
        name,
        backend: entry.backend,
        scope: entry.scope,
        rotatable: entry.rotatable,
        valueType: entry.valueType,
        ...(entry.devValue === undefined ? {} : { devValue: entry.devValue }),
        ...(entry.origin === undefined ? {} : { origin: entry.origin }),
        ...(entry.rotation === undefined ? {} : { rotation: entry.rotation }),
        rotateEveryDays: entry.rotateEveryDays,
        ...(entry.overlap === undefined
          ? {}
          : {
              overlap: {
                days: entry.overlap.days,
                minimumDays: entry.overlap.minimumDays,
                ...(entry.overlap.reencrypt === undefined ? {} : { reencrypt: [...entry.overlap.reencrypt] }),
              },
            }),
      }),
    );
}

/**
 * Parse the manager's `VALUE_ROTATIONS` var. Absent or empty is no schedule; anything else must parse.
 *
 * **A malformed schedule is refused, not skipped.** Skipping would be a cron that silently rotates nothing,
 * and the overdue flag would be the first anyone heard of it. The refusal names the var and never echoes
 * it — a var is config, but it is config nobody should have to read back out of a log.
 */
export function parseStampedRotations(text: string | undefined): StampedRotation[] {
  if (text === undefined || text.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const parsed = StampedRotations.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError({
      message: "The secrets manager's VALUE_ROTATIONS var is not a rotation schedule it can read.",
      action: remedy("secrets provision").say(
        (command) => `Redeploy the manager with ${command}. It rewrites the schedule from the project's registry.`,
      ),
      detail: "VALUE_ROTATIONS did not parse as a list of stamped rotations",
    });
  }
  return parsed.data;
}

/**
 * The registry entry a stamped declaration stands for. Hand it to `defineSecretRegistry` before acting on it:
 * the stamp is external config, and the registry's refusals are what make the rotation safe.
 */
export function stampedEntry(stamped: StampedRotation): SecretRegistryEntry {
  return {
    backend: stamped.backend,
    scope: stamped.scope,
    rotatable: stamped.rotatable,
    // `local` mints text, and nothing else is ever rotated here; a `json` value would need its schema.
    valueType: "text",
    ...(stamped.devValue === undefined ? {} : { devValue: stamped.devValue }),
    ...(stamped.origin === undefined ? {} : { origin: stamped.origin }),
    ...(stamped.rotation === undefined ? {} : { rotation: stamped.rotation }),
    rotateEveryDays: stamped.rotateEveryDays,
    ...(stamped.overlap === undefined ? {} : { overlap: stamped.overlap }),
  };
}

/**
 * The Secrets Store entry a store-backed secret lives at, seen from one environment: its own
 * `<project>-<env>-<name>`, or the project's one `<project>-global-<name>`. The name provisioning wrote and
 * the name an application Worker binds, through the one composer they share.
 */
export function rotationStoreEntry(
  project: string,
  environment: string,
  rotation: Pick<StampedRotation, "name" | "scope">,
): string {
  return environmentScope(project, environment).secretEntry(rotation.name, rotation.scope);
}

/** Why the cron reports a secret rather than rotating it. */
export type ReportReason = "manual" | "no-rotator" | "undeclared";

/** One secret's decision on one tick. */
export type ValueRotationDecision =
  | { name: string; decision: "start" }
  | { name: string; decision: "baseline" }
  | { name: string; decision: "not-due" }
  | { name: string; decision: "not-owner" }
  | { name: string; decision: "refused"; reason: "global-d1" | "json" }
  | { name: string; decision: "report"; reason: ReportReason; overdue: boolean | null };

/** What one tick knows. */
export interface ValueRotationPlanInput {
  /** The schedule, parsed. */
  stamped: readonly StampedRotation[];
  /** This manager's environment. */
  environment: string;
  /** The environment whose manager owns global secrets — the last declared. Absent owns none. */
  globalEnvironment?: string;
  /** The newest successful row for a name in this environment's ledger — a rotation or a baseline — or `null`. */
  lastSuccess: (name: string) => Date | null;
  /**
   * When the schedule last reset a name's clock — its newest rotation, or the baseline the cron recorded when
   * the period first reached it — or `null` while the cron has never recorded one. A baseline written when the
   * secret was created is not a start: it says when the value was set, not when anything began to count.
   */
  scheduledSince: (name: string) => Date | null;
  /** The tick's clock. */
  now: Date;
}

const DAY_MS = 86_400_000;

/** Whether `days` have passed since `since`. */
function elapsed(since: Date, days: number, now: Date): boolean {
  return now.getTime() >= since.getTime() + days * DAY_MS;
}

/**
 * What the cron does with each secret on this tick. Pure, so every rule is a test rather than a claim.
 *
 * - **`start`** — due, rotatable here, and this manager's to rotate.
 * - **`baseline`** — the schedule has never seen it. The first tick records a baseline instead of rotating, so
 *   a period added to an existing secret starts counting from today rather than replacing the value at 03:00
 *   tonight. Its creation-time baseline does not count: every rotatable secret has one, as old as the secret.
 * - **`not-due`**, **`not-owner`** — nothing to do, and nothing wrong.
 * - **`refused`** — a declaration the cron must never act on, arriving anyway.
 * - **`report`** — a secret nothing here can rotate. `overdue` is the same answer the status read gives.
 */
export function planValueRotations(input: ValueRotationPlanInput): ValueRotationDecision[] {
  return input.stamped.map((stamped): ValueRotationDecision => {
    const { name } = stamped;
    if (stamped.scope === "global" && stamped.backend === "d1")
      return { name, decision: "refused", reason: "global-d1" };
    if (stamped.scope === "global" && input.globalEnvironment !== input.environment)
      return { name, decision: "not-owner" };
    const entry = stampedEntry(stamped);
    const last = input.lastSuccess(name);
    if (unattendedRotation(entry) !== "rotates") {
      const reason: ReportReason =
        stamped.rotation === undefined ? "undeclared" : stamped.rotation.kind === "manual" ? "manual" : "no-rotator";
      return {
        name,
        decision: "report",
        reason,
        overdue: last === null ? null : elapsed(last, stamped.rotateEveryDays, input.now),
      };
    }
    if (stamped.valueType !== "text") return { name, decision: "refused", reason: "json" };
    const since = input.scheduledSince(name);
    if (since === null) return { name, decision: "baseline" };
    return elapsed(since, stamped.rotateEveryDays, input.now)
      ? { name, decision: "start" }
      : { name, decision: "not-due" };
  });
}

/** The longest id a Workflow instance may carry. */
const MAX_INSTANCE_ID = 100;

/**
 * The deterministic instance id for one secret's rotation on the UTC day of `at`.
 *
 * Cron delivery is at-least-once, and Cloudflare refuses a duplicate instance id — so two ticks on one day
 * start one rotation. A name an id cannot hold verbatim is kebabbed and suffixed with a digest of the
 * original, so two names that kebab alike still compose two ids.
 */
export function valueRotationInstanceId(name: string, at: Date): string {
  const day = at.toISOString().slice(0, 10);
  const safe = /^[a-zA-Z0-9_-]+$/.test(name) ? name : `${name.replace(/[^a-zA-Z0-9_-]+/g, "-")}-${hash6(name)}`;
  const id = `value-${safe}-${day}`;
  if (id.length <= MAX_INSTANCE_ID) return id;
  const tail = `-${hash6(name)}-${day}`;
  return `value-${safe.slice(0, MAX_INSTANCE_ID - "value-".length - tail.length)}${tail}`;
}
