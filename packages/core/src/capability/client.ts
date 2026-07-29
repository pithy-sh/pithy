import { z } from "zod";
import { fromZodError } from "../error/pithyError";
import type { Capability } from "./capability";

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
 */
export const JsonValue: z.ZodType<JsonValue> = z
  .lazy(() =>
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
  )
  .describe("Any JSON value — string, finite number, boolean, null, array, or plain object.");

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
 */
export const ClientProjection = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Whether the capability is composed and usable in this environment. `false` means a screen must branch, not render.",
      ),
  })
  .catchall(JsonValue)
  .describe("A capability's client-safe projection — the only config values that reach a browser bundle.");
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
