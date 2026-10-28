// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ConsentPurposeId } from "../consent/purpose";
import { fromZodError, ValidationError } from "../error/pithyError";
import { PrivacyClassName } from "../privacy/classes";
import { type BasisSource, LegalBasis } from "./vocabulary";

/**
 * Processing activities: what a Worker does with personal data, why, and on what legal basis — the declarations the
 * GDPR Article 30 record is derived from.
 *
 * ## Declared where the processing is
 *
 * A capability states the activities it performs, under its own `name` (`auth.account`), the rule consent purposes,
 * tables and error codes follow. The adopter adds their own in the `processing` block of a Worker's
 * `pithy.config.ts`, and may replace a capability's legal basis there.
 *
 * ## A missing basis is a gap, never a guess
 *
 * `legalBasis` is optional. An activity without one is reported as a gap in the record, and nothing fills it in.
 */

/** An activity id: `<domain>.<name>`, lowercase, the domain being the declaring capability's name. */
export const ProcessingActivityId = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*$/,
    "A processing activity id is `<domain>.<name>`: lowercase, the domain being the declaring capability's name.",
  )
  .max(128)
  .describe(
    "A processing activity id, `<domain>.<name>` — `auth.account`. The domain is the declaring capability's name, or the adopter's own domain for an activity declared in `pithy.config.ts`.",
  );
export type ProcessingActivityId = z.infer<typeof ProcessingActivityId>;

/** Someone outside the Worker's own code who receives personal data for an activity. */
export const ProcessingRecipient = z
  .object({
    name: z
      .string()
      .min(1)
      .max(120)
      .describe("Who receives it, as an auditor would name them — `Stripe`, `Cloudflare Email Service`."),
    receives: z
      .string()
      .min(1)
      .max(500)
      .describe("What they receive, in one sentence — `The buyer's email address and what they bought.`"),
    classes: z
      .array(PrivacyClassName)
      .default([])
      .describe("The data classes in what they receive — `pii`, `phi`, or an adopter's own."),
  })
  .describe("One recipient of personal data: who it is, what it receives, and the classes in it.");
export type ProcessingRecipient = z.output<typeof ProcessingRecipient>;
export type ProcessingRecipientInput = z.input<typeof ProcessingRecipient>;

/** A consent purpose belongs with a consent basis and nowhere else. */
function consentPurposeNeedsConsent(
  value: { legalBasis?: LegalBasis | undefined; consentPurpose?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.consentPurpose !== undefined && value.legalBasis !== "consent") {
    ctx.addIssue({
      code: "custom",
      path: ["consentPurpose"],
      message:
        "`consentPurpose` names the purpose a `consent` basis rests on. Set `legalBasis` to `consent`, or drop it.",
    });
  }
}

/** One processing activity, as a capability or the adopter declares it. */
export const ProcessingActivity = z
  .object({
    id: ProcessingActivityId,
    purpose: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Why the data is processed, in one sentence an auditor reads — `Keep an account and sign its holder in.`",
      ),
    classes: z
      .array(PrivacyClassName)
      .default([])
      .describe(
        "The data classes the activity uses — `pii`, `phi`, or an adopter's own. Cross-checked against the classes the Worker's schemas store.",
      ),
    legalBasis: LegalBasis.optional().describe(
      "The lawful basis it rests on. Absent is reported as a gap in the processing record, never filled in.",
    ),
    consentPurpose: ConsentPurposeId.optional().describe(
      "For a `consent` basis, the consent purpose the activity rests on — `email.marketing`. The record cites its grant counts.",
    ),
    recipients: z
      .array(ProcessingRecipient)
      .default([])
      .describe(
        "Who receives the data beyond Cloudflare, which the record always lists — a payment rail, a mail provider. Built from the resolved config, so a rail that is off is not named.",
      ),
  })
  .superRefine(consentPurposeNeedsConsent)
  .describe("One processing activity: its purpose, the data classes it uses, its legal basis and its recipients.");
export type ProcessingActivity = z.output<typeof ProcessingActivity>;
export type ProcessingActivityInput = z.input<typeof ProcessingActivity>;

/** The adopter's replacement for a capability's legal basis. */
export const ProcessingOverride = z
  .object({
    legalBasis: LegalBasis.describe("The basis that replaces the capability's own."),
    consentPurpose: ConsentPurposeId.optional().describe(
      "For a `consent` basis, the consent purpose it rests on. Left out, a capability's own purpose is kept.",
    ),
  })
  .strict()
  .superRefine(consentPurposeNeedsConsent)
  .describe("A legal basis the adopter states for a capability's activity, replacing the one it declares.");
export type ProcessingOverride = z.infer<typeof ProcessingOverride>;

/** The `processing` block, as a Worker's `pithy.config.ts` writes it. */
export const ProcessingPolicy = z
  .object({
    activities: z
      .array(ProcessingActivity)
      .optional()
      .describe(
        "Your own processing activities, beside the ones composed capabilities declare. Each under your own domain.",
      ),
    overrides: z
      .record(ProcessingActivityId, ProcessingOverride)
      .optional()
      .describe(
        'A legal basis per capability activity, replacing the one it declares: `{ "auth.account": { legalBasis: "legitimate-interests" } }`.',
      ),
  })
  .strict()
  .describe("What this Worker does with personal data beyond what its capabilities declare, and the bases you state.");
export type ProcessingPolicy = z.output<typeof ProcessingPolicy>;
export type ProcessingPolicyInput = z.input<typeof ProcessingPolicy>;

/** The domain half of an activity id: `auth` for `auth.account`. */
export function activityDomain(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? id : id.slice(0, dot);
}

/**
 * Parse one declarer's activities and refuse what the record could not attribute: an invalid activity, one under a
 * domain that is not the declarer's, or two with one id. `domain` is the declaring capability's name, or `null` for
 * the adopter's own, which may use any domain but a reserved one.
 */
export function parseProcessingActivities(
  declarer: string,
  activities: readonly ProcessingActivityInput[],
  domain: string | null,
  reserved: ReadonlySet<string> = new Set(),
): ProcessingActivity[] {
  const seen = new Set<string>();
  return activities.map((input) => {
    const parsed = ProcessingActivity.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError({
        message: `${declarer} declares a processing activity that is not valid: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
        action:
          "Give it an id of the form `<domain>.<name>` and a purpose; name a consent purpose only under a consent basis.",
      });
    }
    const activity = parsed.data;
    const own = activityDomain(activity.id);
    if (domain !== null && own !== domain) {
      throw new ValidationError({
        message: `The ${declarer} capability declares the processing activity "${activity.id}" outside its own domain.`,
        action: `Name it under ${domain}. — a capability declares activities only under its own name.`,
      });
    }
    if (domain === null && reserved.has(own)) {
      throw new ValidationError({
        message: `The processing activity "${activity.id}" is under ${own}., which a composed capability owns.`,
        action: "Name your own activities under your own domain, such as your app's name.",
      });
    }
    if (seen.has(activity.id)) {
      throw new ValidationError({
        message: `${declarer} declares the processing activity "${activity.id}" twice.`,
        action: "Declare each activity once.",
      });
    }
    seen.add(activity.id);
    return activity;
  });
}

/** Parse a `processing` block, or refuse it naming what is wrong. `undefined` is the empty policy. */
export function parseProcessingPolicy(input: unknown): ProcessingPolicy {
  if (input === undefined) return {};
  const parsed = ProcessingPolicy.safeParse(input);
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: "The processing block in pithy.config.ts does not parse.",
      action: "Fix the field named, then deploy again.",
    });
  }
  return parsed.data;
}

/** One activity as it takes effect: who declared it, its basis after any override, and where that came from. */
export interface ResolvedActivity {
  readonly id: string;
  readonly purpose: string;
  readonly classes: readonly string[];
  readonly legalBasis: LegalBasis | null;
  readonly basisSource: BasisSource | null;
  readonly consentPurpose: string | null;
  readonly recipients: readonly ProcessingRecipient[];
  /** The capability that declared it, or `config` for the adopter's own. */
  readonly declaredBy: string;
}

/** What resolving reads off a composed capability. */
interface ActivityDeclarer {
  readonly name: string;
  readonly processing?: readonly ProcessingActivity[];
}

/** One declared activity, before any override. */
function resolved(activity: ProcessingActivity, declaredBy: string, source: BasisSource): ResolvedActivity {
  return {
    id: activity.id,
    purpose: activity.purpose,
    classes: [...activity.classes],
    legalBasis: activity.legalBasis ?? null,
    basisSource: activity.legalBasis === undefined ? null : source,
    consentPurpose: activity.consentPurpose ?? null,
    recipients: activity.recipients.map((recipient) => ({ ...recipient, classes: [...recipient.classes] })),
    declaredBy,
  };
}

/**
 * Every activity as it takes effect over a composition: each capability's, in composition order, then the adopter's,
 * with the block's overrides applied. Refuses an adopter activity under a composed capability's domain, an id declared
 * twice, and an override naming an activity no composed capability declares. Called when a Worker assembles.
 */
export function resolveProcessing(
  policy: ProcessingPolicy,
  capabilities: readonly ActivityDeclarer[],
): ResolvedActivity[] {
  const reserved = new Set(capabilities.map((capability) => capability.name));
  const own = parseProcessingActivities("pithy.config.ts", policy.activities ?? [], null, reserved);
  const declared = capabilities.flatMap((capability) =>
    (capability.processing ?? []).map((activity) => resolved(activity, capability.name, "capability")),
  );
  const ids = new Set<string>();
  for (const activity of declared) {
    if (ids.has(activity.id)) {
      throw new ValidationError({
        message: `The processing activity "${activity.id}" is declared twice.`,
        action: "Declare each activity once.",
      });
    }
    ids.add(activity.id);
  }
  const overrides = policy.overrides ?? {};
  for (const id of Object.keys(overrides)) {
    if (own.some((activity) => activity.id === id)) {
      throw new ValidationError({
        message: `The processing block overrides "${id}", which is declared in the same block.`,
        action: `State its legal basis on the activity itself.`,
      });
    }
    if (!ids.has(id)) {
      throw new ValidationError({
        message: `The processing block overrides "${id}", which no composed capability declares.`,
        action: "Name an activity a composed capability declares. `GET /control-plane/processing` lists them.",
      });
    }
  }
  const overridden = declared.map((activity): ResolvedActivity => {
    const override = overrides[activity.id];
    if (override === undefined) return activity;
    const consentPurpose =
      override.legalBasis === "consent" ? (override.consentPurpose ?? activity.consentPurpose) : null;
    return { ...activity, legalBasis: override.legalBasis, basisSource: "config", consentPurpose };
  });
  return [...overridden, ...own.map((activity) => resolved(activity, "config", "config"))];
}
