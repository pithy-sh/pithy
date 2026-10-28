// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "../capability/capability";
import type { PurgeSubject } from "../capability/purge";
import { privacyInventory } from "../privacy/inventory";
import { type EffectiveRetention, parseRetentionPolicy, type RetentionComposition, resolveRetention } from "./policy";

/**
 * **The retention policy as this Worker resolved it, reachable from module scope** — so a purge, a prune and
 * an inactivity pass, each running in a Workflow the runtime constructs with `env` alone, read the same policy the
 * routes do. The reasoning, and the cost, are `../capability/composition.ts`'s: `createBackend` runs at module load,
 * one Worker assembles one backend, and a second assembly in one isolate replaces the first wholesale.
 */

/**
 * What resolving reads off a composition: each capability's window, and every lifecycle action it audits — the
 * transitions it declares, then the ones its erasure records.
 */
export function retentionComposition(capabilities: readonly Capability[]): RetentionComposition {
  return {
    purgeWindows: capabilities.flatMap((capability) => (capability.purgeWindow ? [capability.purgeWindow] : [])),
    lifecycleActions: capabilities.flatMap((capability) => {
      const actions = capability.erasureRecords?.auditActions;
      const erasure = actions ? [...actions.deleted, actions.step, actions.failed, actions.purged] : [];
      return [...(capability.lifecycleAuditActions ?? []), ...erasure];
    }),
  };
}

/**
 * Parse and resolve a Worker's `retention` block over what it composes, or refuse it. What `createBackend` calls at
 * assembly and `pithy doctor` calls on the same config, so both report — or refuse — one policy.
 */
export function effectiveRetention(block: unknown, capabilities: readonly Capability[]): EffectiveRetention {
  return resolveRetention(parseRetentionPolicy(block), retentionComposition(capabilities));
}

/** The resolved policy, or null before any backend has been assembled in this isolate. */
let recorded: EffectiveRetention | null = null;

/** Record the resolved policy. Called once by `createBackend`, beside `recordComposition`. */
export function recordRetention(retention: EffectiveRetention): void {
  recorded = retention;
}

/** Forget it. For a test that needs the un-assembled state back. */
export function forgetRetention(): void {
  recorded = null;
}

/**
 * The resolved policy — or, before any assembly, `null`. A caller with a capability's own default in hand falls back
 * to it, which is exactly what an empty block means.
 */
export function composedRetention(): EffectiveRetention | null {
  return recorded;
}

/**
 * The privacy classes a subject's rows hold: every class marked on a schema of a capability that erases that
 * subject in its purge — the capabilities that hold rows keyed to the subject. What the class ages are read against:
 * an account holds `pii` when a capability holding its rows marks a field `pii`.
 */
export function subjectClasses(capabilities: readonly Capability[], subject: PurgeSubject): string[] {
  const holders = new Set(
    capabilities
      .filter((capability) => capability.purge?.some((contribution) => contribution.subject === subject))
      .map((capability) => capability.name),
  );
  const classes = privacyInventory(capabilities)
    .schemas.filter((schema) => holders.has(schema.capability))
    .flatMap((schema) => schema.fields.map((field) => field.class));
  return [...new Set(classes)].sort();
}
