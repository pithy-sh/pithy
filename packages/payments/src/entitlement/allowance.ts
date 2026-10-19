// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import {
  type AllowanceDeclarations,
  declaredFeatureNames,
  declaredQuotaNames,
  type FeatureMap,
  type QuotaMap,
  type QuotaValue,
} from "../config/allowances";

/**
 * How much a subject may have, resolved — the one implementation of the order every reader shares.
 *
 * **The order, and it fails closed:**
 *
 * 1. The subject's **override**, when it names this allowance. A pin beats everything, `unrestricted`
 *    included, so `unrestricted` with `emails: 20000` is unlimited everywhere except email.
 * 2. **`unrestricted`**, when the override carries it: unlimited and on, for every name — including one
 *    declared after the override was written, which is why it is a mode and not a list.
 * 3. The **highest** value among every key the subject holds that speaks to this name. `null` (unlimited)
 *    beats every number, and a feature is on when any held key turns it on. A customer holding two products
 *    is owed the larger of what they bought, and an upgrade overlapping an old subscription's tail must
 *    never read as a downgrade for those weeks.
 * 4. **`defaults`**, the free floor, for a name no held key speaks to.
 * 5. **`0` for a quota, `false` for a feature.** Never unlimited. A name that resolved to unlimited because
 *    nothing declared it is a paywall that silently does not exist.
 *
 * **The reader takes no key, and that is the point.** A caller does not know which tier the subject is on,
 * and during an upgrade overlap it holds two. Resolving across every held key is what makes a tier ladder
 * unnecessary: an adopter compares numbers, never ranks, and the kit stays without an opinion on whether
 * `growth` outranks `start`.
 *
 * Pure: the caller hands in the held keys and the override row, so the order is testable without a
 * database, and the gate's middleware, the admin read and the meters all reach the same answer.
 */

/** Where an allowance's value came from. `none` is the hard floor: nothing declared spoke to it. */
export type AllowanceSource = "unrestricted" | "override" | "plan" | "default" | "none";

/** What a subject's override says. Sparse: a name it does not carry resolves normally. */
export interface AllowanceOverride {
  /** Unlimited and on, for every name present and future, except the names the patch pins. */
  unrestricted: boolean;
  /** Pinned quotas, by name. */
  quotas: QuotaMap;
  /** Pinned features, by name. */
  features: FeatureMap;
}

/** One resolved value and where it came from. */
export interface ResolvedValue<T> {
  /** The value. */
  value: T;
  /** Where it came from. */
  source: AllowanceSource;
  /** The entitlement key that supplied it, when `source` is `plan`. Null otherwise. */
  key: string | null;
}

/** One quota, resolved: what applies now, and what would apply with the override removed. */
export interface ResolvedQuota {
  /** The quota name. */
  name: string;
  /** What applies now. */
  effective: ResolvedValue<QuotaValue>;
  /** What would apply with no override — the plan's own number, for a pane to show and revert to. */
  inherited: ResolvedValue<QuotaValue>;
}

/** One feature, resolved. */
export interface ResolvedFeature {
  /** The feature name. */
  name: string;
  /** What applies now. */
  effective: ResolvedValue<boolean>;
  /** What would apply with no override. */
  inherited: ResolvedValue<boolean>;
}

/** Every declared allowance for one subject, resolved. */
export interface ResolvedAllowances {
  /** Every declared quota, by name order. */
  quotas: ResolvedQuota[];
  /** Every declared feature, by name order. */
  features: ResolvedFeature[];
}

/** What resolution reads: the declarations, the keys granting now, and the override row if there is one. */
export interface AllowanceInput {
  /** The project's declarations. */
  declarations: AllowanceDeclarations;
  /** Every entitlement key the subject holds that grants access now. */
  held: ReadonlySet<string>;
  /** The subject's override, or null. */
  override: AllowanceOverride | null;
}

/** Whether `candidate` is more than `current` — `null` is unlimited and beats every number. */
function larger(candidate: QuotaValue, current: QuotaValue): boolean {
  if (current === null) return false;
  if (candidate === null) return true;
  return candidate > current;
}

/**
 * A quota map's value for a name the caller has already checked is present. `?? 0` would be wrong here and
 * dangerously so: `null` is unlimited, and a nullish fallback reads it as nothing.
 */
function quotaAt(map: QuotaMap, name: string): QuotaValue {
  const value = map[name];
  return value === undefined ? 0 : value;
}

/** Held keys in a stable order, so the key named as a value's source does not depend on set order. */
function heldInOrder(held: ReadonlySet<string>): string[] {
  return [...held].sort();
}

/** The value a quota has with no override: highest held, then the floor, then zero. */
function inheritedQuota(input: AllowanceInput, name: string): ResolvedValue<QuotaValue> {
  let best: ResolvedValue<QuotaValue> | undefined;
  for (const key of heldInOrder(input.held)) {
    const declaration = input.declarations.entitlements[key];
    if (declaration === undefined || !(name in declaration.quotas)) continue;
    const value = quotaAt(declaration.quotas, name);
    if (best === undefined || larger(value, best.value)) best = { value, source: "plan", key };
  }
  if (best !== undefined) return best;
  const floor = input.declarations.defaults?.quotas;
  if (floor !== undefined && name in floor) return { value: quotaAt(floor, name), source: "default", key: null };
  return { value: 0, source: "none", key: null };
}

/** The value a feature has with no override: on if any held key says on, then the floor, then off. */
function inheritedFeature(input: AllowanceInput, name: string): ResolvedValue<boolean> {
  let spoke: ResolvedValue<boolean> | undefined;
  for (const key of heldInOrder(input.held)) {
    const declaration = input.declarations.entitlements[key];
    if (declaration === undefined || !(name in declaration.features)) continue;
    if (declaration.features[name] === true) return { value: true, source: "plan", key };
    spoke ??= { value: false, source: "plan", key };
  }
  if (spoke !== undefined) return spoke;
  const floor = input.declarations.defaults?.features;
  if (floor !== undefined && name in floor) return { value: floor[name] === true, source: "default", key: null };
  return { value: false, source: "none", key: null };
}

/** One quota, resolved through the whole order. */
export function resolveQuota(input: AllowanceInput, name: string): ResolvedQuota {
  const inherited = inheritedQuota(input, name);
  const override = input.override;
  if (override !== null && name in override.quotas) {
    return { name, effective: { value: quotaAt(override.quotas, name), source: "override", key: null }, inherited };
  }
  if (override?.unrestricted) return { name, effective: { value: null, source: "unrestricted", key: null }, inherited };
  return { name, effective: inherited, inherited };
}

/** One feature, resolved through the whole order. */
export function resolveFeature(input: AllowanceInput, name: string): ResolvedFeature {
  const inherited = inheritedFeature(input, name);
  const override = input.override;
  if (override !== null && name in override.features) {
    return {
      name,
      effective: { value: override.features[name] === true, source: "override", key: null },
      inherited,
    };
  }
  if (override?.unrestricted) return { name, effective: { value: true, source: "unrestricted", key: null }, inherited };
  return { name, effective: inherited, inherited };
}

/** Every declared quota and feature for one subject. What the admin read projects. */
export function resolveAllowances(input: AllowanceInput): ResolvedAllowances {
  return {
    quotas: declaredQuotaNames(input.declarations).map((name) => resolveQuota(input, name)),
    features: declaredFeatureNames(input.declarations).map((name) => resolveFeature(input, name)),
  };
}

/**
 * Refuse a read of a quota nobody declared, naming it and listing what is declared.
 *
 * **A hard failure, never a default.** `quota(c, "emals")` resolving to `0` would deny quietly, and
 * resolving to unlimited would be a paywall that does not exist — and a typo in a name is exactly the bug
 * that reads as either. `core/internal`, because it is the adopter's code that is wrong, and an operator
 * reading the log is who fixes it.
 */
export function requireDeclaredQuota(declarations: AllowanceDeclarations, name: string): void {
  const declared = declaredQuotaNames(declarations);
  if (declared.includes(name)) return;
  throw new InternalError({
    message: `No quota "${name}" is declared.`,
    action: "Declare it under `quotas` on an entitlement or in `defaults` in pithy.config.ts, or correct the name.",
    detail: `quota("${name}") names nothing the payments declarations mention. Declared quotas: ${declared.join(", ") || "none"}.`,
  });
}

/** The same refusal for a feature. */
export function requireDeclaredFeature(declarations: AllowanceDeclarations, name: string): void {
  const declared = declaredFeatureNames(declarations);
  if (declared.includes(name)) return;
  throw new InternalError({
    message: `No feature "${name}" is declared.`,
    action: "Declare it under `features` on an entitlement or in `defaults` in pithy.config.ts, or correct the name.",
    detail: `feature("${name}") names nothing the payments declarations mention. Declared features: ${declared.join(", ") || "none"}.`,
  });
}
