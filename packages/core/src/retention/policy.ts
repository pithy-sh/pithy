// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { fromZodError, ValidationError } from "../error/pithyError";
import { PrivacyClassName } from "../privacy/classes";

/**
 * **How long everything is kept, declared in one place.**
 *
 * A Worker's `pithy.config.ts` carries one `retention` block beside its `capabilities`, so the policy is bundled
 * with the code that enforces it and deployed like it. Three things are governed:
 *
 * - **Purge windows.** How long a deleted user or organization stays restorable before its purge. Each capability
 *   that owns a deletion keeps its own `retention.purgeAfterDays` as the default; a window stated here replaces it.
 * - **Audit retention.** How long audit events are kept, by action prefix, with a default. Absent means forever.
 *   The prune Workflow in `@pithy-sh/audit` removes events past their window and leaves a checkpointed tombstone.
 * - **Class ages.** The longest an account may sit inactive while it holds a privacy class. An account untouched
 *   for longer than the strictest class it holds is soft-deleted through the lifecycle that already exists.
 *
 * **The kit holds a floor under the audit trail.** No rule may keep `controlplane/*` or a lifecycle action for
 * less than {@link AUDIT_RETENTION_FLOOR_DAYS} days, and a rule that would is refused when the config loads. The
 * default is not a rule: a short default leaves the floored actions at the floor, and the manifest says so.
 *
 * Nothing here shortens anything at runtime. The policy is code, and no route changes it.
 */

/** A day, in ms. */
export const MS_PER_DAY = 86_400_000;

/** The least the kit keeps a floored audit action: a year. */
export const AUDIT_RETENTION_FLOOR_DAYS = 365;

/**
 * The action prefixes the floor always covers, whatever is composed. The control plane's own trail — every call,
 * every key, every hold — is the record of who managed the Worker, and it outlives any short default.
 */
export const FLOORED_AUDIT_PREFIXES = ["controlplane/"] as const;

/** Days per unit of a duration string. A month is thirty days and a year is 365: a policy, not a calendar. */
const UNIT_DAYS = { d: 1, w: 7, m: 30, y: 365 } as const;

/** The longest any duration may be: a century. Past that, say `forever`. */
const MAX_DAYS = 36_500;

/**
 * A length of time: whole days as a number, or a count and a unit — `90d`, `12w`, `18m`, `3y`. A month is thirty
 * days and a year is 365.
 */
export const RetentionDuration = z
  .union([
    z.number().int().min(1).max(MAX_DAYS),
    z.string().regex(/^[1-9]\d{0,4}[dwmy]$/, "A duration is a whole number and a unit: `90d`, `12w`, `18m` or `3y`."),
  ])
  .describe(
    "A length of time: whole days as a number, or a count and a unit — `90d`, `12w`, `18m`, `3y`. A month is thirty days and a year is 365.",
  );
export type RetentionDuration = z.infer<typeof RetentionDuration>;

/** A duration in whole days. */
export function durationDays(value: RetentionDuration): number {
  if (typeof value === "number") return value;
  const unit = value.slice(-1) as keyof typeof UNIT_DAYS;
  return Number(value.slice(0, -1)) * UNIT_DAYS[unit];
}

/** An audit action prefix: a domain, a slash, and as much of the reason as the rule means. */
const AuditActionPrefix = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*\/[a-z0-9_.]*$/,
    "An audit prefix is a domain and a slash, optionally followed by the start of a reason: `auth/`, `support/thread_`.",
  )
  .describe(
    "An audit action prefix: a domain and a slash, optionally the start of a reason — `auth/`, `support/thread_`. The longest prefix matching an action decides its window.",
  );

/** The `retention` block, as a Worker's `pithy.config.ts` writes it. */
export const RetentionPolicy = z
  .object({
    purgeWindows: z
      .object({
        user: RetentionDuration.optional().describe(
          "How long a deleted account stays restorable before its purge. Replaces `auth({ retention: { purgeAfterDays } })`.",
        ),
        organization: RetentionDuration.optional().describe(
          "How long a deleted organization stays restorable before its purge. Replaces `organization({ retention: { purgeAfterDays } })`.",
        ),
      })
      .strict()
      .optional()
      .describe(
        "Every soft-delete window, in one place. A subject left out keeps the window its own capability configures.",
      ),
    audit: z
      .object({
        default: z
          .union([RetentionDuration, z.literal("forever")])
          .optional()
          .describe(
            "How long an audit event no prefix names is kept. Absent, or `forever`, keeps it forever. Never applied under the floor to a floored action.",
          ),
        prefixes: z
          .record(AuditActionPrefix, RetentionDuration)
          .optional()
          .describe(
            "How long events are kept by action prefix. The longest matching prefix wins. A rule under 365 days that covers `controlplane/*` or a lifecycle action is refused.",
          ),
      })
      .strict()
      .optional()
      .describe("How long the audit trail is kept. Absent keeps everything forever."),
    classAges: z
      .record(PrivacyClassName, RetentionDuration)
      .optional()
      .describe(
        'The longest an account may sit inactive — no sign-in, no session — while it holds a privacy class: `{ pii: "3y" }`. Past the strictest class it holds, it is soft-deleted through the lifecycle, with its notice mail and its purge window.',
      ),
  })
  .strict()
  .describe("How long this Worker keeps deleted accounts, the audit trail and each class of personal data.");
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;
export type RetentionPolicyInput = z.input<typeof RetentionPolicy>;

/** Where an effective value came from: this block, a capability's own config, or the kit's floor. */
export const RetentionSource = z
  .enum(["policy", "capability", "floor"])
  .describe(
    "Where the value came from: `policy`, the `retention` block; `capability`, the capability's own config, because the block names none; `floor`, the kit's minimum for the audit trail.",
  );
export type RetentionSource = z.infer<typeof RetentionSource>;

/** The policy as it takes effect: every value resolved to days, and where each came from. */
export const EffectiveRetention = z
  .object({
    purgeWindows: z
      .array(
        z
          .object({
            subject: z.enum(["user", "organization"]).describe("Whose deletion the window governs."),
            days: z.number().int().min(0).describe("How many days a deletion stays restorable before its purge."),
            source: RetentionSource,
          })
          .describe("One soft-delete window as it takes effect."),
      )
      .describe("Every soft-delete window a composed capability runs, in composition order."),
    audit: z
      .object({
        defaultDays: z
          .number()
          .int()
          .min(1)
          .nullable()
          .describe("How long an event no rule names is kept, in days. Null keeps it forever."),
        floorDays: z
          .number()
          .int()
          .min(1)
          .describe("The least the kit keeps `controlplane/*` and every lifecycle action, in days."),
        rules: z
          .array(
            z
              .object({
                prefix: z.string().describe("The action prefix, or a floored action in full."),
                days: z.number().int().min(1).describe("How long matching events are kept, in days."),
                source: RetentionSource,
              })
              .describe("One audit rule as it takes effect."),
          )
          .describe(
            "Every rule, longest prefix first. A `floor` rule is the kit holding a floored action at the floor under a shorter default.",
          ),
        floored: z
          .array(z.string())
          .describe("Every prefix and action the floor covers: `controlplane/` and each composed lifecycle action."),
      })
      .describe("How long the audit trail is kept."),
    classAges: z
      .array(
        z
          .object({
            class: PrivacyClassName.describe("The privacy class."),
            days: z.number().int().min(1).describe("The longest an account holding it may sit inactive, in days."),
          })
          .describe("One class age."),
      )
      .describe("Every class age the block declares, strictest first."),
  })
  .describe("This Worker's retention, as it takes effect: every window in days, and where each came from.");
export type EffectiveRetention = z.infer<typeof EffectiveRetention>;

/** A capability's own soft-delete window, the default a policy may replace. */
export interface PurgeWindowDefault {
  readonly subject: "user" | "organization";
  readonly days: number;
}

/** What resolving needs from the composition: each capability's window, and the lifecycle actions it audits. */
export interface RetentionComposition {
  /** Each composed capability's own soft-delete window, in composition order. */
  readonly purgeWindows: readonly PurgeWindowDefault[];
  /** Every lifecycle audit action the composed capabilities record — the floor covers each. */
  readonly lifecycleActions: readonly string[];
}

/** Whether a rule's prefix would decide the window of a floored prefix or action. */
function covers(prefix: string, floored: string): boolean {
  return floored.startsWith(prefix) || prefix.startsWith(floored);
}

/**
 * Parse a `retention` block, or refuse it naming what is wrong. `undefined` is the empty policy: every capability's
 * own window, an audit trail kept forever, no class ages.
 */
export function parseRetentionPolicy(input: unknown): RetentionPolicy {
  if (input === undefined) return {};
  const parsed = RetentionPolicy.safeParse(input);
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: "The retention block in pithy.config.ts does not parse.",
      action: "Fix the field named, then deploy again.",
    });
  }
  return parsed.data;
}

/**
 * The policy as it takes effect over a composition — or refused, when a rule would keep a floored action for less
 * than the floor. Called when a Worker assembles, so a policy that would prune the control plane's trail early never
 * deploys.
 */
export function resolveRetention(policy: RetentionPolicy, composition: RetentionComposition): EffectiveRetention {
  const floored = [...FLOORED_AUDIT_PREFIXES, ...new Set(composition.lifecycleActions)];
  const rules = Object.entries(policy.audit?.prefixes ?? {}).map(([prefix, duration]) => ({
    prefix,
    days: durationDays(duration),
    source: "policy" as RetentionSource,
  }));
  for (const rule of rules) {
    if (rule.days >= AUDIT_RETENTION_FLOOR_DAYS) continue;
    const hit = floored.find((each) => covers(rule.prefix, each));
    if (hit !== undefined) {
      throw new ValidationError({
        message: `The retention block keeps ${rule.prefix} for ${rule.days} days, under the kit's floor of ${AUDIT_RETENTION_FLOOR_DAYS} for ${hit}.`,
        action: `Keep it at least ${AUDIT_RETENTION_FLOOR_DAYS} days, or name a narrower prefix that leaves ${hit} out.`,
        detail: `audit retention rule ${rule.prefix}=${rule.days}d covers floored ${hit}`,
      });
    }
  }
  const fallback = policy.audit?.default;
  const defaultDays = fallback === undefined || fallback === "forever" ? null : durationDays(fallback);
  // Under a default shorter than the floor, every floored action no rule already decides is held at the floor.
  if (defaultDays !== null && defaultDays < AUDIT_RETENTION_FLOOR_DAYS) {
    for (const each of floored) {
      const decided = rules.some((rule) => each.startsWith(rule.prefix));
      if (!decided) rules.push({ prefix: each, days: AUDIT_RETENTION_FLOOR_DAYS, source: "floor" });
    }
  }
  rules.sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));

  const windows = policy.purgeWindows ?? {};
  const purgeWindows = composition.purgeWindows.map(({ subject, days }) => {
    const stated = windows[subject];
    return stated === undefined
      ? { subject, days, source: "capability" as RetentionSource }
      : { subject, days: durationDays(stated), source: "policy" as RetentionSource };
  });

  const classAges = Object.entries(policy.classAges ?? {})
    .map(([name, duration]) => ({ class: name, days: durationDays(duration) }))
    .sort((a, b) => a.days - b.days || a.class.localeCompare(b.class));

  return { purgeWindows, audit: { defaultDays, floorDays: AUDIT_RETENTION_FLOOR_DAYS, rules, floored }, classAges };
}

/**
 * How many days an audit event with this action is kept, or `null` for forever. The longest matching rule decides;
 * with none, the default. A floored action is never kept under the floor, whichever decided.
 */
export function auditWindowDays(retention: EffectiveRetention, action: string): number | null {
  const rule = retention.audit.rules.find((each) => action.startsWith(each.prefix));
  const days = rule?.days ?? retention.audit.defaultDays;
  if (days === null) return null;
  const floored = retention.audit.floored.some((each) => action.startsWith(each));
  return floored ? Math.max(days, retention.audit.floorDays) : days;
}

/** Whether the policy prunes any audit event at all. */
export function prunesAudit(retention: EffectiveRetention): boolean {
  return retention.audit.defaultDays !== null || retention.audit.rules.some((rule) => rule.source === "policy");
}

/** The soft-delete window for a subject, in days, or `undefined` when no composed capability runs one. */
export function purgeWindowDays(retention: EffectiveRetention, subject: "user" | "organization"): number | undefined {
  return retention.purgeWindows.find((each) => each.subject === subject)?.days;
}

/**
 * The longest an account may sit inactive given the classes it holds, in days — the strictest class age among
 * them — or `null` when no class it holds has an age.
 */
export function inactivityDays(retention: EffectiveRetention, held: readonly string[]): number | null {
  const ages = retention.classAges.filter((age) => held.includes(age.class)).map((age) => age.days);
  return ages.length === 0 ? null : Math.min(...ages);
}
