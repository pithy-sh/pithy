// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * What an entitlement buys: a display name, numbered allowances, and switches. Declared once per key.
 *
 * A key is the thing gating code names and the thing a product mentions — `growth` — and until this
 * existed it was declared nowhere. It was only ever *mentioned*, in the array a product grants and in a
 * second list of comp-only keys, and those two could disagree about the same key with no answer for which
 * won. There was also nowhere to write what a key buys: "up to 25 students" could gate on the key and
 * could not tell 25 from 26.
 *
 * **The declaration hangs on the key, not on the product, because a tier is sold by more than one
 * product.** `growth_monthly` and `growth_annual` are two SKUs on two rails for one tier. Writing the
 * numbers on the product writes them twice and reconciles them forever.
 *
 * **Two maps, not one.** A single `limits: { emails: 5000, sso: true }` reads well and answers
 * `number | boolean | null`, and from there no caller can tell `0` from `false` from *nothing was
 * declared* without writing the same narrowing every time. `quotas` holds integers and `null`, and
 * `features` holds booleans, so each reader answers one type.
 *
 * **`null` is unlimited, and it is written, never inferred.** A quota a key does not mention is not
 * unlimited for that key — it falls to `defaults`, then to `0`. Unlimited is a decision somebody wrote
 * down, because a paywall that silently does not exist is invisible until the invoice.
 */

/** The longest an allowance name may be. Long enough to read, short enough to sit in an audit row. */
const MAX_ALLOWANCE_NAME_LENGTH = 64;

/** The longest a declared tier name may be — the same bound a product's display name carries. */
const MAX_TIER_NAME_LENGTH = 120;

/**
 * A quota or feature name — `emails`, `seats`, `auditExport`. camelCase or snake_case, starting with a
 * lowercase letter, because it is an identifier code names and never copy a screen renders.
 */
export const AllowanceName = z
  .string()
  .min(1)
  .max(MAX_ALLOWANCE_NAME_LENGTH)
  .regex(
    /^[a-z][A-Za-z0-9_]*$/,
    "An allowance name starts with a lowercase letter and holds only letters, digits, and underscores.",
  )
  .describe(
    "A quota or feature name — `emails`, `seats`, `auditExport`. An identifier gating code reads, never display copy, and never translated.",
  );
export type AllowanceName = z.infer<typeof AllowanceName>;

/**
 * One quota's value: a whole number of things, or `null` for unlimited. Never a float, never negative,
 * never a string — a number that costs money to serve is not something to coerce.
 */
export const QuotaValue = z
  .number()
  .int("A quota is a whole number, or null for unlimited.")
  .min(0, "A quota is never negative. Use 0 for none and null for unlimited.")
  .nullable()
  .describe("How many of a thing this grants: a whole number from 0, or null for unlimited.");
export type QuotaValue = z.infer<typeof QuotaValue>;

/** A ceiling an operator's override may not pass. A whole number, and never unlimited — that is not a ceiling. */
export const OverrideCeiling = z
  .number()
  .int("An override ceiling is a whole number.")
  .min(0, "An override ceiling is never negative.")
  .describe(
    "The largest number an operator's override may set for this quota. A set past it is refused naming it, never clamped.",
  );
export type OverrideCeiling = z.infer<typeof OverrideCeiling>;

/** A quota map: name → whole number or unlimited. */
export const QuotaMap = z
  .record(AllowanceName, QuotaValue)
  .describe("Numbered allowances by name. A whole number from 0, or null for unlimited.");
export type QuotaMap = z.infer<typeof QuotaMap>;

/** A feature map: name → on or off. */
export const FeatureMap = z
  .record(AllowanceName, z.boolean().describe("Whether this switch is on."))
  .describe("Switches by name. A feature is read, never enforced: `false` denies nothing on its own.");
export type FeatureMap = z.infer<typeof FeatureMap>;

export const PaymentsEntitlementDeclaration = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_TIER_NAME_LENGTH)
      .describe(
        "The tier's display name — `Growth`. A product name, so it is not translated, the way a product's own name is not.",
      ),
    quotas: QuotaMap.default({}).describe(
      "What this key allows, by name — `{ emails: 5000, seats: 10 }`. A whole number from 0, or null for unlimited. Read with `quota(c, name)`, which resolves across every key the subject holds and answers the highest.",
    ),
    features: FeatureMap.default({}).describe(
      "The switches this key turns on or off, by name — `{ sso: true }`. Read with `feature(c, name)`, which is true when any held key says true. Never enforced on its own.",
    ),
    overrideMax: z
      .record(AllowanceName, OverrideCeiling)
      .optional()
      .describe(
        "Optional. Per quota, the largest number an operator's override may set — so `200000000` is refused where `20000` was meant. A quota with no ceiling accepts any whole number. Must name a quota this key declares, and must not sit below that quota's own value.",
      ),
  })
  .describe(
    "What one entitlement key buys: its display name, its numbered quotas, and its switches. Declared once, however many products sell it.",
  );
export type PaymentsEntitlementDeclaration = z.output<typeof PaymentsEntitlementDeclaration>;
export type PaymentsEntitlementDeclarationInput = z.input<typeof PaymentsEntitlementDeclaration>;

export const PaymentsAllowanceDefaults = z
  .object({
    quotas: QuotaMap.default({}).describe(
      "What a subject holding no key that speaks to a quota gets — the free floor. A name absent here resolves to 0.",
    ),
    features: FeatureMap.default({}).describe(
      "The switches a subject holding no key that speaks to them gets. A name absent here resolves to false.",
    ),
  })
  .describe(
    "The free floor: what a caller holding no key gets. Optional, and omitting it means an unentitled caller gets 0 of every quota and no feature.",
  );
export type PaymentsAllowanceDefaults = z.output<typeof PaymentsAllowanceDefaults>;

/** The slice of a parsed config the derivations below read. Structural, so a test needs no full catalog. */
export interface AllowanceDeclarations {
  /** Every declared entitlement key and what it buys. */
  entitlements: Readonly<Record<string, PaymentsEntitlementDeclaration>>;
  /** The free floor, when declared. */
  defaults?: PaymentsAllowanceDefaults | undefined;
}

/**
 * Every quota name this project declares, on any key or on the floor, sorted.
 *
 * Derived, never written down, the way the set of grantable keys is derived from the products — a second
 * list of names would be a list that disagrees with the declarations the first time one is added.
 */
export function declaredQuotaNames(declarations: AllowanceDeclarations): string[] {
  const names = new Set<string>(Object.keys(declarations.defaults?.quotas ?? {}));
  for (const declaration of Object.values(declarations.entitlements)) {
    for (const name of Object.keys(declaration.quotas)) names.add(name);
  }
  return [...names].sort();
}

/** Every feature name this project declares, on any key or on the floor, sorted. */
export function declaredFeatureNames(declarations: AllowanceDeclarations): string[] {
  const names = new Set<string>(Object.keys(declarations.defaults?.features ?? {}));
  for (const declaration of Object.values(declarations.entitlements)) {
    for (const name of Object.keys(declaration.features)) names.add(name);
  }
  return [...names].sort();
}

/**
 * The problems with a set of declarations, as sentences, each with the path it belongs at.
 *
 * Separate from the schema so `PaymentsConfig`'s check can report every one at once, beside the catalog
 * problems it already reports, and so each rule is testable on its own.
 */
export interface DeclarationProblem {
  /** Where in the config the problem is. */
  path: (string | number)[];
  /** The sentence. Names the key and the name. */
  message: string;
}

/**
 * Check the rules a schema cannot state field by field: a name that is a quota on one key and a feature on
 * another, and an `overrideMax` that names an undeclared quota or sits below the quota it bounds.
 */
export function declarationProblems(declarations: AllowanceDeclarations): DeclarationProblem[] {
  const problems: DeclarationProblem[] = [];

  // A name is a number or a switch, everywhere. `quota(c, "sso")` and `feature(c, "sso")` both answering
  // would give one name two meanings, and an override editor could not say which input to draw.
  const quotas = new Set(declaredQuotaNames(declarations));
  for (const name of declaredFeatureNames(declarations)) {
    if (!quotas.has(name)) continue;
    problems.push({
      path: ["entitlements"],
      message: `"${name}" is declared as both a quota and a feature. A name is a number or a switch, never both. Rename one.`,
    });
  }

  for (const [key, declaration] of Object.entries(declarations.entitlements)) {
    for (const [name, ceiling] of Object.entries(declaration.overrideMax ?? {})) {
      if (!(name in declaration.quotas)) {
        problems.push({
          path: ["entitlements", key, "overrideMax", name],
          message: `Entitlement "${key}" sets an overrideMax for "${name}", which it declares no quota for. A ceiling bounds a quota the key declares. Declared: ${Object.keys(declaration.quotas).sort().join(", ") || "none"}.`,
        });
        continue;
      }
      const value = declaration.quotas[name];
      // A ceiling under the plan's own number would refuse an override the plan already grants. Unlimited
      // is above every ceiling, so a ceiling on an unlimited quota is always under it.
      if (value === null || (value !== undefined && ceiling < value)) {
        problems.push({
          path: ["entitlements", key, "overrideMax", name],
          message: `Entitlement "${key}" caps overrides of "${name}" at ${ceiling}, below the ${value === null ? "unlimited" : value} the plan itself grants. A ceiling under the plan would refuse an override the plan already allows.`,
        });
      }
    }
  }
  return problems;
}
