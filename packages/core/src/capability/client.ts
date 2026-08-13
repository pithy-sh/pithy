// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { fromZodError } from "../error/pithyError";
import type { Capability } from "./capability";
import { refusesVanishingKey } from "./vanishingKey";

/**
 * Who has to go and fix a projection that states a key which vanishes. The guard names them, and for a
 * projection that is the capability author, not the adopter.
 */
const SUBJECT = "A capability's client projection";

/**
 * A JSON value — the only thing that may cross into a browser bundle. Recursive, so an object or
 * array of JSON values is one too. Declared as a type first because a Zod schema cannot infer its
 * own recursion (CLAUDE.md §Zod: the const and the type share one name).
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Whether a value is a plain record — `{}` or `Object.create(null)`, never a `Date`, `Map`, or class. */
function isPlainRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * The JSON value space, as a schema. `z.lazy` carries the recursion. The record branch is guarded by
 * a plain-object check first: `z.record` alone accepts a `Date` (it has no own enumerable keys) and
 * would quietly project it as `{}`. A non-finite number is rejected for the same reason — `JSON.stringify`
 * turns `NaN` into `null`, which is a silent value change, not a projection.
 *
 * `refusesVanishingKey` is the third check of the same kind, and the one this schema was missing: a
 * `__proto__` key written by a capability is dropped by `z.record` with no issue raised, so it never
 * reaches the bundle and nothing says it was written. See `vanishingKey.ts`.
 *
 * It wraps the **whole value**, outside the union, and both halves of that matter. Whole value, because
 * this is the recursion: every string, array and object in a projection is a `JsonValue`, so guarding it
 * once covers a space nobody can enumerate, at a depth nobody has to predict. Non-objects pass the check
 * by definition, so the cost is a `typeof` per node. Outside the union, because a refusal raised by one
 * branch of a union is reported as the union's own — measured, the message for a key one level down was
 * `Invalid input`, and out here it is the guard's own sentence at the key's own path.
 *
 * Below an array it is `Invalid union` again, with the guard's sentence nested in `issue.errors`. That is
 * how this union reports every rejection it makes — a `Date` at the same depth reads the same way today —
 * so it is the union's shape to fix, not this guard's, and it is written here so the next reader knows it
 * was seen rather than missed.
 */
export const JsonValue: z.ZodType<JsonValue> = refusesVanishingKey(
  z.lazy(() =>
    z.union([
      z.string(),
      z.number().refine((value) => Number.isFinite(value), { error: "Expected a finite number." }),
      z.boolean(),
      z.null(),
      z.array(JsonValue),
      z
        .custom<Record<string, unknown>>(isPlainRecord, { error: "Expected a plain JSON object." })
        .pipe(z.record(z.string(), JsonValue)),
    ]),
  ),
  SUBJECT,
).describe("Any JSON value — string, finite number, boolean, null, array, or plain object.");

/**
 * What a capability's client projection is resolved against. A projection is per build, not per
 * request: the plugin inlines the result into the bundle, so the only axis it varies on is the
 * environment being built for (a Turnstile sitekey differs between staging and production).
 */
export const ClientProjectionContext = z
  .object({
    environment: z
      .string()
      .min(1)
      .describe(
        "The environment this bundle is built for — `dev`, `staging`, `production`, or an adopter's own name. Per-environment config (a Turnstile sitekey) resolves against it.",
      ),
  })
  .describe("The build-time context a capability's client projection is resolved against.");
export type ClientProjectionContext = z.output<typeof ClientProjectionContext>;

/**
 * One capability's client-safe projection — the **only** values of its config that may reach a
 * browser bundle. `enabled` is always present so a screen can branch (`false` means the capability is
 * absent, or configured in a way this environment cannot render); everything else is the capability's
 * own JSON, validated by the catchall. This validation is the security boundary of `virtual:pithy/*`:
 * a capability cannot smuggle a function, a `Date`, or an unserializable value into the bundle, and a
 * new config field never ships to browsers unless its capability adds it here on purpose.
 *
 * Guarded a second time, and this is the one place in the file where that is not redundant. `JsonValue`
 * covers every object *inside* a projection; the projection's own top level is this object, parsed by the
 * object branch rather than the record one, and Zod drops `__proto__` there too. So the recursion closes
 * everything below the root and the root closes itself. Two sites, and the walk in `vanishingKey.test.ts`
 * is what says they are the only two.
 */
const PROJECTION_DESCRIPTION =
  "A capability's client-safe projection — the only config values that reach a browser bundle.";
export const ClientProjection = refusesVanishingKey(
  z
    .object({
      enabled: z
        .boolean()
        .describe(
          "Whether the capability is composed and usable in this environment. `false` means a screen must branch, not render.",
        ),
    })
    .catchall(JsonValue)
    .describe(PROJECTION_DESCRIPTION),
  SUBJECT,
).describe(PROJECTION_DESCRIPTION);
export type ClientProjection = z.output<typeof ClientProjection>;

/**
 * Resolve one capability's client projection, validated. An absent capability, or one that declares no
 * projection, is `{ enabled: false }` — never an error, because a front end is written against the
 * capabilities it may have, not the ones it does. A declared projection is parsed through
 * {@link ClientProjection}, so a non-JSON value is a build failure rather than a broken bundle.
 */
export function resolveClientProjection(
  capability: Capability | undefined,
  context: ClientProjectionContext,
): ClientProjection {
  if (!capability?.client) return { enabled: false };
  const resolvedContext = ClientProjectionContext.parse(context);
  const projected = ClientProjection.safeParse(capability.client(resolvedContext));
  if (!projected.success) {
    throw fromZodError(projected.error, {
      message: `The ${capability.name} capability's client projection is not JSON.`,
      action: `Return only JSON values from the ${capability.name} capability's \`client\` projection — no functions, dates, or undefined.`,
      detail: `environment=${resolvedContext.environment}`,
    });
  }
  return projected.data;
}
