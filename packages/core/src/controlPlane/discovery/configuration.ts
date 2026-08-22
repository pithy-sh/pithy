// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { InternalError } from "../../error/pithyError";

/**
 * The configured facts a capability states into its own manifest entry (#422).
 *
 * **A management client cannot call an operation it has to guess an argument for.**
 * `POST {base}/entitlements/grant` names the holder and never assumes it, which is right — but
 * `PaymentsConfig.billingSubject` decides whether this project's holders are people or organizations,
 * it is required with no default, and nothing on the wire said so. A client guessing `user` against an
 * organization-billed project writes a row nothing reads: the call succeeds, the audit line is real,
 * the screen says `Done.`, and the person still cannot use what somebody just gave them. That is worse
 * than a refusal, because it looks like it worked.
 *
 * So a capability declares the configured facts a client must respect, and the manifest carries them
 * beside the routes they govern. `billingSubject` is the first and will not be the last, which is why
 * this is a vocabulary rather than one field bolted onto the manifest.
 *
 * ## This is not health, and the difference is the whole design
 *
 * The shapes rhyme — `configKeys`/`config` beside `healthKeys`/`health` — and a reader who folds them
 * together gets both wrong. They differ on every axis that matters:
 *
 * - A health value is **per caller**; a configured fact is the same for everybody.
 * - A health value is **produced**, so it may fail, and `unavailable` is one of its four states. A fact
 *   is read off resolved config at assembly, so there is no producer, no query, and no failure state to
 *   collapse into a zero.
 * - A health value is **as old as the manifest a client cached** and must never be shown as live. A
 *   fact changes only when the adopter redeploys, which is when the manifest changes anyway.
 * - A health value is a number to **render**. A fact is a decision to **respect** — it goes into the
 *   next request a client makes, not onto a rail.
 *
 * ## No per-key scope, deliberately
 *
 * A health key's `scope` is required, on the stated ground that a count is still a fact
 * about somebody's security posture. A configured fact is not that. `billingSubject` names no account,
 * no transaction and no amount, and reads identically against an empty database — it is a fact about
 * the adopter's own configuration, and the whole manifest already sits behind `manifest:read`, the same
 * gate that discloses every route, every scope and every composed version.
 *
 * Withholding stays addable with no wire change if a later fact wants it — a from-address, a region. A
 * value absent from `config` while its key is present in `configKeys` already means "declared and not
 * shown", which is the same pairing that tells `undeclared` from `withheld` for health, and
 * {@link namedConfigValues} already survives it.
 *
 * ## What keeps it from becoming a config dump
 *
 * A capability's resolved config holds provider secrets, price ids and an adopter's whole catalog. The
 * factory is the only door, and it is narrow on purpose: scalars only, a closed declared vocabulary,
 * and a value refused unless something declared it. Nobody can write `manifestConfig: resolved`.
 */

/** A fact's name: one camelCase token, so it reads as a field and never as a path or an id. */
const MANIFEST_CONFIG_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;

/**
 * One configured fact's value. A string, a number, or a boolean — never anything else.
 *
 * The rule is in the type rather than in a comment: a config object, a product list, or a credentials
 * bag does not compile, so the seam cannot become the route by which an adopter's catalog reaches a
 * discovery read.
 */
export const ManifestConfigValue = z
  .union([z.string(), z.number(), z.boolean()])
  .describe(
    "One scalar: a word, a number, or a flag. Nothing else is representable — no nested objects, no lists, no credentials.",
  );
export type ManifestConfigValue = z.output<typeof ManifestConfigValue>;

/** Anything that is not a scalar. Named as a type so the tripwire below is a list to delete from. */
type NonScalar = object | ((...args: never[]) => unknown);

/**
 * `true` while `T` is scalars only, `never` the moment it admits anything else — so the assignment
 * below stops compiling if {@link ManifestConfigValue} is ever widened.
 *
 * Declared here rather than imported from `health.ts`: that module reaches `capability.ts` and, through
 * it, hono and kysely, and this one is zod-only so a browser client can read the manifest without them
 * (#430). The tuple wrapper is not decoration — a bare `Extract<...> extends never` distributes over a
 * union and would answer `true` for every member, which is the one way this check could quietly pass.
 */
type ScalarOnly<T> = [Extract<T, NonScalar>] extends [never] ? true : never;

/** The compile-time half of "scalars only". Widen the value type and this line names the file. */
export const MANIFEST_CONFIG_VALUE_IS_SCALAR_ONLY: ScalarOnly<ManifestConfigValue> = true;

/**
 * One configured fact a capability may state, declared alongside its routes.
 *
 * `choices` is nullable rather than optional, and a null means "no closed list" rather than "not
 * decided yet": a client renders a fact it has never heard of from the summary, and offers a picker
 * only where the values are enumerable. A base path has no list; what a project bills has exactly two.
 */
export const ManifestConfigKey = z
  .object({
    key: z
      .string()
      .regex(MANIFEST_CONFIG_KEY_PATTERN, "A config key is one camelCase token — `billingSubject`.")
      .describe("The key this fact appears under in the capability's config. One camelCase token."),
    choices: z
      .array(z.string().min(1))
      .min(1, "A closed list needs a value in it. Write null where the values are not enumerable.")
      .nullable()
      .describe(
        "Every value this fact may take, so a client can offer the same choice the adopter made, or null where the values are not enumerable. At least one where it is a list: an empty one is not `null` spelled differently, it is a list nothing satisfies, so the capability could never boot and the refusal would name no permitted value at all. Read off the capability's own enum rather than retyped, so a new member cannot land without the manifest learning it.",
      ),
    summary: z
      .string()
      .min(1)
      .describe("One line saying what the fact governs, for a client to render beside it without knowing the key."),
  })
  .describe(
    "One configured fact a capability states: what it is called, what it may be, and what it decides — enough for a client to respect a decision it did not make.",
  );
export type ManifestConfigKey = z.output<typeof ManifestConfigKey>;

/**
 * A capability's configured facts as the manifest carries them: declared key → scalar.
 *
 * A record rather than a closed object, because the vocabulary is federated the way scopes and audit
 * actions are — the capability name already namespaces it. **Parsing tolerates a key it has never heard
 * of on purpose**: a client reading a newer Worker must drop the unknown one rather than fail the whole
 * manifest, which is what {@link namedConfigValues} does with it.
 */
export const ManifestConfigValues = z
  .record(z.string(), ManifestConfigValue)
  .describe(
    "One capability's configured facts: each declared key to its scalar. Unknown keys parse rather than throw, so a client of an older build reads what it knows and nothing for the rest.",
  );
export type ManifestConfigValues = z.output<typeof ManifestConfigValues>;

/**
 * The brand only {@link defineManifestConfig} can produce.
 *
 * Module-local and never exported, so nothing outside this file can write it: the factory becomes the
 * **only** way to build the seam, and a fact therefore cannot reach a manifest without having been
 * checked against a declaration. An inline object literal on `Capability.manifestConfig` is a compile
 * error, which is what stops the next capability from stating a fact nothing validated.
 */
const manifestConfigSeam: unique symbol = Symbol("pithy.controlPlane.manifestConfig");

/** What a capability declares and what it resolved to. Built only by {@link defineManifestConfig}. */
export interface CapabilityManifestConfig {
  /** The brand. Present only on a declaration that went through the factory, and never serialized. */
  readonly [manifestConfigSeam]: true;
  /** The closed vocabulary: every fact this capability states, parsed. */
  readonly keys: readonly ManifestConfigKey[];
  /** What each declared fact resolved to for this composition. One answer, for every caller. */
  readonly values: ManifestConfigValues;
}

/** The authoring shape — facts as written, before parsing. */
export interface CapabilityManifestConfigInput {
  /** Every fact this capability states. At least one; an empty vocabulary states nothing. */
  keys: readonly z.input<typeof ManifestConfigKey>[];
  /** The resolved value of each declared fact. Built from the capability's parsed config, never its defaults. */
  values: ManifestConfigValues;
}

/**
 * Declare a capability's configured facts. The one constructor, so every declaration in the tree is
 * checked — the key against the name pattern, the values against the keys, and each value against its
 * own closed list.
 *
 * **Nothing downstream re-checks this.** `missingAdminRoutes` keeps a route declaration honest against
 * the router that mounted it, and there is no equivalent here: the declaration and the value come from
 * the same object, so the only defense against a fact that disagrees with the capability is building it
 * from the *resolved* config at the one call site, exactly as `adminRoutes` is built from the resolved
 * `basePath`.
 *
 * Every refusal is an {@link InternalError} rather than a bare `ZodError`, key named, because every one
 * of them is an author's mistake read off a deploy that would not start — and an author reading it
 * wants the problem line and the action line the rest of this kit gives them.
 */
export function defineManifestConfig(input: CapabilityManifestConfigInput): CapabilityManifestConfig {
  if (input.keys.length === 0) {
    throw new InternalError({
      message: "A capability declared configured facts with no keys.",
      action: "Declare at least one key, or omit the manifest config entirely.",
      detail: "defineManifestConfig received an empty key list; an empty vocabulary states no fact.",
    });
  }
  const keys: ManifestConfigKey[] = [];
  const declared = new Map<string, ManifestConfigKey>();
  for (const written of input.keys) {
    const parsed = ManifestConfigKey.safeParse(written);
    if (!parsed.success) {
      throw new InternalError({
        message: "A capability declared a configured fact its own schema refuses.",
        action: "Name the fact with one camelCase token, list its values or null, and say what it decides.",
        detail: `manifest config key ${JSON.stringify(written)} is invalid: ${parsed.error.message}`,
      });
    }
    if (declared.has(parsed.data.key)) {
      throw new InternalError({
        message: "A capability declared the same configured fact twice.",
        action: "Give each fact one declaration — the second silently decides what the first meant.",
        detail: `manifest config key ${parsed.data.key} is declared more than once`,
      });
    }
    declared.set(parsed.data.key, parsed.data);
    keys.push(parsed.data);
  }
  const parsed = ManifestConfigValues.safeParse(input.values);
  if (!parsed.success) {
    throw new InternalError({
      message: "A capability stated a configured fact that is not a scalar.",
      action: "State a word, a number or a flag. A capability's own config never crosses whole.",
      detail: `manifest config values are invalid: ${parsed.error.message}`,
    });
  }
  const values = parsed.data;
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) {
      throw new InternalError({
        message: "A capability stated a configured fact it never declared.",
        action: "Declare the fact alongside the capability's routes, or stop stating it.",
        detail: `manifest config value ${key} has no declaration, so a client could only guess at what it means`,
      });
    }
  }
  for (const key of keys) {
    // `Object.hasOwn` rather than an `undefined` check. `ManifestConfigValues` parses to a plain object, so
    // `values.toString` is a function off `Object.prototype` — and the key pattern admits `toString`,
    // `valueOf` and `constructor`. A declaration named after one of them would read a method as its
    // value and walk straight through the guard below, which is the one state the guard exists for.
    const value = Object.hasOwn(values, key.key) ? values[key.key] : undefined;
    if (value === undefined) {
      throw new InternalError({
        message: "A capability declared a configured fact and stated no value for it.",
        action: "State every declared fact, or remove the declaration.",
        detail: `manifest config key ${key.key} is declared and has no value`,
      });
    }
    if (key.choices !== null && !(typeof value === "string" && key.choices.includes(value))) {
      throw new InternalError({
        message: "A capability stated a configured fact its own declaration does not permit.",
        action: "State one of the declared choices, or widen the declaration to the enum it came from.",
        // The value itself: the declaration already said it may be published, and knowing *which* value
        // was refused is most of the diagnosis.
        detail: `manifest config key ${key.key} was given ${JSON.stringify(value)}, which is not one of ${key.choices.join(", ")}`,
      });
    }
  }
  return { [manifestConfigSeam]: true, keys, values };
}

/** One fact with the declaration that says how to read it. */
export interface NamedConfigValue {
  /** The declaration — its closed list, if it has one, and what it decides. */
  key: ManifestConfigKey;
  /** The value this composition resolved it to. */
  value: ManifestConfigValue;
}

/**
 * Pair a capability's configured facts with their declarations, dropping any value nothing declares.
 *
 * This is how "an unknown fact reads as nothing rather than as an error" is real rather than
 * aspirational: a client reads what this returns, so a key from a Worker newer than its build simply is
 * not in the list — and a fact it cannot name is a fact it would otherwise have to guess the meaning of.
 */
export function namedConfigValues(descriptor: {
  configKeys: readonly ManifestConfigKey[];
  config: ManifestConfigValues;
}): NamedConfigValue[] {
  const named: NamedConfigValue[] = [];
  for (const key of descriptor.configKeys) {
    // Own keys only, for the reason {@link defineManifestConfig} states: a declared `toString` with no
    // value beside it would otherwise pair with `Object.prototype.toString`, and this function's whole
    // promise is that a `value` is a scalar a client can render.
    if (!Object.hasOwn(descriptor.config, key.key)) continue;
    const value = descriptor.config[key.key];
    if (value !== undefined) named.push({ key, value });
  }
  return named;
}
