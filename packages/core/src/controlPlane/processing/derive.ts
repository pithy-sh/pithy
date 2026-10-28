// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ConsentPurpose } from "../../consent/purpose";
import type { ConsentPurposeStanding } from "../../consent/reader";
import type { PrivacyInventory } from "../../privacy/report";
import type { ResolvedActivity } from "../../processing/activity";
import type { RecipientSource } from "../../processing/vocabulary";
import type { EffectiveRetention } from "../../retention/policy";
import { EVIDENCE_CONTROLS, type EvidenceControlId, type EvidenceState } from "../evidence/mapping";
import type {
  ControlPlaneProcessingResponse,
  ProcessingConsentView,
  ProcessingEntry,
  ProcessingGap,
  ProcessingRecipientView,
  ProcessingRetentionView,
} from "../http/responses";

/**
 * The record of processing activities, derived. Pure: `./read.ts` gathers what the Worker declares and records, and
 * this turns it into the GDPR Article 30 record.
 *
 * **It describes the processing and changes none of it.** Every gap is named and none is filled in: an activity with
 * no legal basis reads as having none, and the record never guesses one.
 */

/** The evidence pack's controls that protect stored personal data, which every activity cites. */
export const PROCESSING_MEASURES = [
  "data-protection",
  "audit-logging",
  "management-access",
  "key-rotation",
  "route-verification",
  "csrf",
] as const satisfies readonly EvidenceControlId[];

/** The platform every Worker runs on, which receives everything it serves and stores. */
export const CLOUDFLARE = "Cloudflare";

const CLOUDFLARE_RECEIVES =
  "Every request this Worker serves, and everything it stores in D1, KV, R2 and Durable Objects.";

/** What the record knows of consent. */
export type ConsentInput =
  /** The composed reader answered: every purpose in its catalog, with counts. */
  | { readonly state: "read"; readonly standings: readonly ConsentPurposeStanding[] }
  /** No consent capability is composed: purposes may be declared, and no grant can be recorded. */
  | { readonly state: "not-composed"; readonly declared: readonly ConsentPurpose[] }
  /**
   * A reader is composed and its record could not be read: its whole catalog, read from memory, or null where the
   * reader cannot list one.
   */
  | { readonly state: "unreadable"; readonly catalog: readonly ConsentPurpose[] | null };

/** A recipient a binding implies, on the capability that declares the binding. */
export interface BindingRecipient {
  readonly name: string;
  readonly receives: string;
  readonly classes: readonly string[];
  readonly capability: string;
}

/** Everything the derivation reads. */
export interface ProcessingInputs {
  readonly activities: readonly ResolvedActivity[];
  /** The privacy inventory, or null where it could not be walked. */
  readonly inventory: PrivacyInventory | null;
  /** The resolved retention, or null where the Worker recorded none. */
  readonly retention: EffectiveRetention | null;
  readonly consent: ConsentInput;
  readonly bindingRecipients: readonly BindingRecipient[];
  /** Each control's state from the evidence pack, or null where the connection may not read it. */
  readonly measures: Readonly<Partial<Record<EvidenceControlId, EvidenceState>>> | null;
  /** Whether a gap may name a stored table and field, which only a connection holding `privacy:read` may read. */
  readonly fieldNames: boolean;
}

/** The record, without the envelope the route adds. */
export type DerivedProcessingRecord = Omit<ControlPlaneProcessingResponse, "environment" | "generatedAt" | "version">;

/** A capability shaped enough to say which bindings it needs. */
interface BindingDeclarer {
  readonly name: string;
  readonly requiredBindings: readonly { readonly type: string; readonly name: string }[];
}

/** Workers AI, once for each capability whose `ai` binding this Worker has. */
export function workersAiRecipients(
  capabilities: readonly BindingDeclarer[],
  env: Record<string, unknown>,
): BindingRecipient[] {
  return capabilities.flatMap((capability) =>
    capability.requiredBindings
      .filter((binding) => binding.type === "ai" && env[binding.name] != null)
      .map((binding) => ({
        name: "Cloudflare Workers AI",
        receives: `What ${capability.name} sends for inference through the ${binding.name} binding.`,
        classes: [],
        capability: capability.name,
      })),
  );
}

/** The catalog's purposes, however the record learned of them, or null where it could learn none. */
function catalogOf(consent: ConsentInput): ReadonlyMap<string, ConsentPurpose> | null {
  const purposes =
    consent.state === "read"
      ? consent.standings.map((entry) => entry.purpose)
      : consent.state === "unreadable"
        ? consent.catalog
        : consent.declared;
  return purposes === null ? null : new Map(purposes.map((purpose) => [purpose.id, purpose]));
}

/** A consent-based activity's purpose and its counts, where they are known. */
function consentView(id: string, consent: ConsentInput): ProcessingConsentView {
  const purpose = catalogOf(consent)?.get(id);
  const counted = consent.state === "read" ? consent.standings.find((entry) => entry.purpose.id === id) : undefined;
  const zero = consent.state === "not-composed" && purpose !== undefined ? 0 : null;
  return {
    purpose: id,
    noticeVersion: purpose?.noticeVersion ?? null,
    explicit: purpose?.explicit ?? null,
    grants: counted?.grants ?? zero,
    withdrawals: counted?.withdrawals ?? zero,
    standing: counted?.standing ?? zero,
  };
}

/** The retention behind an activity's classes. */
function retentionView(
  classes: readonly string[],
  retention: EffectiveRetention | null,
): ProcessingRetentionView | null {
  if (retention === null) return null;
  return {
    classAges: retention.classAges.filter((age) => classes.includes(age.class)).map((age) => ({ ...age })),
    purgeWindows: retention.purgeWindows.map((window) => ({ ...window })),
  };
}

/** A recipient as the record shows it. */
function recipient(
  name: string,
  receives: string,
  classes: readonly string[],
  source: RecipientSource,
): ProcessingRecipientView {
  return { name, receives, classes: [...classes], source };
}

/** The gaps one activity has. */
function activityGaps(
  activity: ResolvedActivity,
  stored: ReadonlySet<string> | null,
  catalog: ReadonlyMap<string, ConsentPurpose> | null,
): ProcessingGap[] {
  const gaps: ProcessingGap[] = [];
  if (activity.legalBasis === null) {
    gaps.push({
      kind: "no-legal-basis",
      subject: activity.id,
      detail: "No legal basis is declared. State one on the activity, or in the processing block's overrides.",
    });
  }
  if (activity.legalBasis === "consent") {
    if (activity.consentPurpose === null) {
      gaps.push({
        kind: "no-consent-purpose",
        subject: activity.id,
        detail: "The basis is consent and no consent purpose is named.",
      });
    } else if (catalog !== null && !catalog.has(activity.consentPurpose)) {
      gaps.push({
        kind: "no-consent-purpose",
        subject: activity.id,
        detail: `The basis is consent, and no composed catalog declares the purpose ${activity.consentPurpose}.`,
      });
    }
  }
  if (stored !== null) {
    const unstored = activity.classes.filter((each) => !stored.has(each));
    if (unstored.length > 0) {
      gaps.push({
        kind: "class-not-stored",
        subject: activity.id,
        detail: `It claims ${unstored.join(", ")}, which no composed schema stores.`,
      });
    }
  }
  return gaps;
}

/** Stored classes no activity of their capability, and none of the adopter's, claims. Tables only with field names. */
function unclaimedGaps(
  activities: readonly ResolvedActivity[],
  inventory: PrivacyInventory,
  fieldNames: boolean,
): ProcessingGap[] {
  const adopter = new Set(activities.filter((each) => each.declaredBy === "config").flatMap((each) => each.classes));
  const byCapability = new Map<string, Map<string, Set<string>>>();
  for (const schema of inventory.schemas) {
    const claimed = new Set(
      activities.filter((each) => each.declaredBy === schema.capability).flatMap((each) => each.classes),
    );
    for (const field of schema.fields) {
      if (claimed.has(field.class) || adopter.has(field.class)) continue;
      const classes = byCapability.get(schema.capability) ?? new Map<string, Set<string>>();
      const tables = classes.get(field.class) ?? new Set<string>();
      tables.add(schema.name);
      classes.set(field.class, tables);
      byCapability.set(schema.capability, classes);
    }
  }
  return [...byCapability].flatMap(([capability, classes]) =>
    [...classes].map(([cls, tables]) => ({
      kind: "class-unclaimed" as const,
      subject: capability,
      detail: fieldNames
        ? `It stores ${cls} in ${[...tables].join(", ")}, and no processing activity claims it.`
        : `It stores ${cls}, and no processing activity claims it.`,
    })),
  );
}

/**
 * Every stored `phi` field no consent purpose in the catalog covers: field by field with field names, and otherwise
 * once for each capability that stores one. Silent where the catalog is unknown.
 */
function uncoveredPhi(
  inventory: PrivacyInventory,
  catalog: ReadonlyMap<string, ConsentPurpose> | null,
  fieldNames: boolean,
): ProcessingGap[] {
  if (catalog === null) return [];
  const covered = [...catalog.values()].some((purpose) => purpose.classes.includes("phi"));
  if (covered) return [];
  if (!fieldNames) {
    const capabilities = new Set(
      inventory.schemas
        .filter((schema) => schema.fields.some((field) => field.class === "phi"))
        .map((schema) => schema.capability),
    );
    return [...capabilities].map((capability) => ({
      kind: "phi-not-covered" as const,
      subject: capability,
      detail: "It stores phi, and no consent purpose covers phi.",
    }));
  }
  return inventory.schemas.flatMap((schema) =>
    schema.fields
      .filter((field) => field.class === "phi")
      .map((field) => ({
        kind: "phi-not-covered" as const,
        subject: `${schema.capability}/${schema.name}.${field.path}`,
        detail: "A phi field is stored, and no consent purpose covers phi.",
      })),
  );
}

/** Every purpose covering a class that holds no standing grant. Silent where the record could not be read. */
function grantlessPurposes(consent: ConsentInput): ProcessingGap[] {
  if (consent.state === "unreadable") return [];
  if (consent.state === "not-composed") {
    return consent.declared
      .filter((purpose) => purpose.classes.length > 0)
      .map((purpose) => ({
        kind: "no-standing-grant" as const,
        subject: purpose.id,
        detail: `It covers ${purpose.classes.join(", ")}, and no consent capability is composed to record a grant.`,
      }));
  }
  return consent.standings
    .filter((entry) => entry.purpose.classes.length > 0 && entry.standing === 0)
    .map((entry) => ({
      kind: "no-standing-grant" as const,
      subject: entry.purpose.id,
      detail: `It covers ${entry.purpose.classes.join(", ")}, and no subject holds a current, unexpired grant.`,
    }));
}

/** Derive the record from what the Worker declares and records. */
export function deriveProcessingRecord(inputs: ProcessingInputs): DerivedProcessingRecord {
  const { activities, inventory, retention, consent } = inputs;
  const stored = inventory === null ? null : new Set(inventory.observed);
  const catalog = catalogOf(consent);

  const entries: ProcessingEntry[] = activities.map((activity) => ({
    id: activity.id,
    purpose: activity.purpose,
    declaredBy: activity.declaredBy,
    classes: [...activity.classes],
    legalBasis: activity.legalBasis,
    basisSource: activity.basisSource,
    consent:
      activity.legalBasis === "consent" && activity.consentPurpose !== null
        ? consentView(activity.consentPurpose, consent)
        : null,
    recipients: [
      recipient(CLOUDFLARE, CLOUDFLARE_RECEIVES, activity.classes, "platform"),
      ...inputs.bindingRecipients
        .filter((each) => each.capability === activity.declaredBy)
        .map((each) => recipient(each.name, each.receives, each.classes, "binding")),
      ...activity.recipients.map((each) => recipient(each.name, each.receives, each.classes, "declared")),
    ],
    retention: retentionView(activity.classes, retention),
    measures: [...PROCESSING_MEASURES],
    gaps: activityGaps(activity, stored, catalog),
  }));

  const recipients: ProcessingRecipientView[] = [
    recipient(CLOUDFLARE, CLOUDFLARE_RECEIVES, inventory?.observed ?? [], "platform"),
  ];
  const seen = new Set<string>();
  const others = [
    ...inputs.bindingRecipients.map((each) => recipient(each.name, each.receives, each.classes, "binding")),
    ...activities.flatMap((activity) =>
      activity.recipients.map((each) => recipient(each.name, each.receives, each.classes, "declared")),
    ),
  ];
  for (const each of others) {
    const key = `${each.name}\u0000${each.receives}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(each);
  }

  const notDerivable: string[] = [];
  if (inventory === null) {
    notDerivable.push("The privacy inventory could not be walked, so data classes are not cross-checked.");
  }
  if (consent.state === "unreadable") {
    notDerivable.push("The consent record could not be read, so grant counts are unknown.");
  }
  if (catalog === null) {
    notDerivable.push(
      "The consent catalog could not be listed, so consent purposes and phi coverage are not cross-checked.",
    );
  }

  return {
    activities: entries,
    recipients,
    measures: PROCESSING_MEASURES.map((control) => ({
      control,
      title: EVIDENCE_CONTROLS[control].title,
      soc2: [...EVIDENCE_CONTROLS[control].soc2],
      iso27001: [...EVIDENCE_CONTROLS[control].iso27001],
      state: inputs.measures?.[control] ?? null,
    })),
    gaps: [
      ...(inventory === null ? [] : unclaimedGaps(activities, inventory, inputs.fieldNames)),
      ...(inventory === null ? [] : uncoveredPhi(inventory, catalog, inputs.fieldNames)),
      ...grantlessPurposes(consent),
    ],
    notDerivable,
  };
}
