// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ConsentPurpose } from "../../consent/purpose";
import type { PrivacyInventory, PrivacyInventorySchema } from "../../privacy/report";
import type { ResolvedActivity } from "../../processing/activity";
import type { EffectiveRetention } from "../../retention/policy";
import { ControlPlaneProcessingResponse } from "../http/responses";
import {
  type ConsentInput,
  deriveProcessingRecord,
  PROCESSING_MEASURES,
  type ProcessingInputs,
  workersAiRecipients,
} from "./derive";

const account: ResolvedActivity = {
  id: "auth.account",
  purpose: "Keep an account and sign its holder in.",
  classes: ["pii"],
  legalBasis: "contract",
  basisSource: "capability",
  consentPurpose: null,
  recipients: [],
  declaredBy: "auth",
};

function schema(capability: string, name: string, fields: [string, string][]): PrivacyInventorySchema {
  return {
    capability,
    storage: "d1",
    container: "app",
    name,
    fields: fields.map(([path, cls]) => ({ path, class: cls })),
    encrypted: [],
  };
}

function inventory(schemas: PrivacyInventorySchema[]): PrivacyInventory {
  const classes = schemas.flatMap((each) => each.fields.map((field) => field.class));
  return {
    sources: ["d1", "kv"],
    schemasWalked: schemas.length,
    schemas,
    counts: {},
    observed: [...new Set(classes)],
    encryptedFields: 0,
    unrotatable: 0,
  };
}

const users = schema("auth", "pithyAuthUsers", [
  ["name", "pii"],
  ["email", "pii"],
]);

const retention: EffectiveRetention = {
  purgeWindows: [{ subject: "user", days: 30, source: "capability" }],
  audit: { defaultDays: null, floorDays: 365, rules: [], floored: ["controlplane/"] },
  classAges: [
    { class: "phi", days: 365 },
    { class: "pii", days: 1095 },
  ],
};

const records = ConsentPurpose.parse({
  id: "clinic.records",
  summary: "Keep my health records.",
  noticeVersion: 3,
  classes: ["phi"],
  explicit: true,
});

const noConsent: ConsentInput = { state: "not-composed", declared: [] };

function inputs(overrides: Partial<ProcessingInputs> = {}): ProcessingInputs {
  return {
    activities: [account],
    inventory: inventory([users]),
    retention,
    consent: noConsent,
    bindingRecipients: [],
    measures: null,
    fieldNames: true,
    ...overrides,
  };
}

const derive = (overrides: Partial<ProcessingInputs> = {}) => deriveProcessingRecord(inputs(overrides));

describe("deriveProcessingRecord", () => {
  test("lists each activity with its purpose, classes, basis, retention and the measures it cites", () => {
    const record = derive();
    expect(record.activities).toEqual([
      {
        id: "auth.account",
        purpose: "Keep an account and sign its holder in.",
        declaredBy: "auth",
        classes: ["pii"],
        legalBasis: "contract",
        basisSource: "capability",
        consent: null,
        recipients: [
          {
            name: "Cloudflare",
            receives: expect.stringContaining("Every request"),
            classes: ["pii"],
            source: "platform",
          },
        ],
        retention: {
          classAges: [{ class: "pii", days: 1095 }],
          purgeWindows: [{ subject: "user", days: 30, source: "capability" }],
        },
        measures: [...PROCESSING_MEASURES],
        gaps: [],
      },
    ]);
    expect(record.gaps).toEqual([]);
    expect(record.notDerivable).toEqual([]);
  });

  test("an activity with no legal basis is a gap, and nothing fills the basis in", () => {
    const [entry] = derive({ activities: [{ ...account, legalBasis: null, basisSource: null }] }).activities;
    expect(entry?.legalBasis).toBeNull();
    expect(entry?.gaps).toEqual([{ kind: "no-legal-basis", subject: "auth.account", detail: expect.any(String) }]);
  });

  test("a claimed class nothing stores, and a stored class no activity claims, are each named", () => {
    const record = derive({
      activities: [{ ...account, classes: ["pii", "pci"] }],
      inventory: inventory([users, schema("support", "pithySupportThreads", [["body", "phi"]])]),
    });
    expect(record.activities[0]?.gaps).toEqual([
      { kind: "class-not-stored", subject: "auth.account", detail: expect.stringContaining("pci") },
    ]);
    expect(record.gaps).toContainEqual({
      kind: "class-unclaimed",
      subject: "support",
      detail: expect.stringContaining("pithySupportThreads"),
    });
  });

  test("an adopter activity claims a class for every capability that stores it", () => {
    const own: ResolvedActivity = {
      ...account,
      id: "clinic.intake",
      classes: ["phi"],
      declaredBy: "config",
      basisSource: "config",
    };
    const record = derive({
      activities: [account, own],
      inventory: inventory([users, schema("support", "pithySupportThreads", [["body", "phi"]])]),
    });
    expect(record.gaps.filter((gap) => gap.kind === "class-unclaimed")).toEqual([]);
  });

  test("an unreadable inventory leaves the cross-check undone and says so, rather than claiming no gaps", () => {
    const record = derive({ inventory: null });
    expect(record.notDerivable.join(" ")).toMatch(/privacy inventory/);
    expect(record.activities[0]?.gaps).toEqual([]);
  });

  test("a consent-based entry cites its purpose and its grant counts", () => {
    const consented: ResolvedActivity = {
      ...account,
      id: "clinic.records",
      classes: ["phi"],
      legalBasis: "consent",
      consentPurpose: "clinic.records",
      declaredBy: "config",
    };
    const record = derive({
      activities: [consented],
      inventory: inventory([schema("clinic", "patients", [["history", "phi"]])]),
      consent: { state: "read", standings: [{ purpose: records, grants: 5, withdrawals: 2, standing: 4 }] },
    });
    expect(record.activities[0]?.consent).toEqual({
      purpose: "clinic.records",
      noticeVersion: 3,
      explicit: true,
      grants: 5,
      withdrawals: 2,
      standing: 4,
    });
    expect(record.activities[0]?.gaps).toEqual([]);
    expect(record.gaps).toEqual([]);
  });

  test("a consent basis naming no purpose, or one no catalog declares, is a gap", () => {
    const consented: ResolvedActivity = { ...account, legalBasis: "consent", consentPurpose: null };
    expect(derive({ activities: [consented] }).activities[0]?.gaps.map((gap) => gap.kind)).toEqual([
      "no-consent-purpose",
    ]);
    const unknown = derive({ activities: [{ ...consented, consentPurpose: "clinic.ghost" }] }).activities[0];
    expect(unknown?.gaps.map((gap) => gap.kind)).toEqual(["no-consent-purpose"]);
    expect(unknown?.consent).toEqual({
      purpose: "clinic.ghost",
      noticeVersion: null,
      explicit: null,
      grants: null,
      withdrawals: null,
      standing: null,
    });
  });

  test("a stored phi field no consent purpose covers is named, field by field", () => {
    const record = derive({ inventory: inventory([users, schema("clinic", "patients", [["history", "phi"]])]) });
    expect(record.gaps).toContainEqual({
      kind: "phi-not-covered",
      subject: "clinic/patients.history",
      detail: expect.any(String),
    });
  });

  test("a covered class whose purpose holds no standing grant is named", () => {
    const record = derive({
      inventory: inventory([users, schema("clinic", "patients", [["history", "phi"]])]),
      consent: { state: "read", standings: [{ purpose: records, grants: 2, withdrawals: 0, standing: 0 }] },
    });
    expect(record.gaps.map((gap) => [gap.kind, gap.subject])).toContainEqual(["no-standing-grant", "clinic.records"]);
    expect(record.gaps.map((gap) => gap.kind)).not.toContain("phi-not-covered");
  });

  test("with no consent capability composed, a declared purpose covering a class can hold no grant", () => {
    const record = derive({ consent: { state: "not-composed", declared: [records] } });
    expect(record.gaps).toContainEqual({
      kind: "no-standing-grant",
      subject: "clinic.records",
      detail: expect.stringMatching(/no consent capability/),
    });
  });

  test("an unreadable consent record leaves the counts unknown and names no grant gap it cannot see", () => {
    const record = derive({ consent: { state: "unreadable", catalog: [records] } });
    expect(record.gaps.map((gap) => gap.kind)).not.toContain("no-standing-grant");
    expect(record.notDerivable.join(" ")).toMatch(/consent record/);
  });

  test("an unreadable record still knows the catalog, so an adopter's purpose and its phi cover are no gap", () => {
    const care: ResolvedActivity = {
      ...account,
      id: "clinic.care",
      classes: ["phi"],
      legalBasis: "consent",
      consentPurpose: "clinic.records",
      declaredBy: "config",
    };
    const record = derive({
      activities: [care],
      inventory: inventory([schema("clinic", "patients", [["history", "phi"]])]),
      consent: { state: "unreadable", catalog: [records] },
    });
    expect(record.activities[0]?.gaps).toEqual([]);
    expect(record.activities[0]?.consent).toEqual({
      purpose: "clinic.records",
      noticeVersion: 3,
      explicit: true,
      grants: null,
      withdrawals: null,
      standing: null,
    });
    expect(record.gaps).toEqual([]);
  });

  test("with neither the record nor the catalog readable, no purpose or phi gap is guessed, and it says so", () => {
    const care: ResolvedActivity = {
      ...account,
      id: "clinic.care",
      classes: ["phi"],
      legalBasis: "consent",
      consentPurpose: "clinic.records",
      declaredBy: "config",
    };
    const record = derive({
      activities: [care, { ...care, id: "clinic.other", consentPurpose: null }],
      inventory: inventory([schema("clinic", "patients", [["history", "phi"]])]),
      consent: { state: "unreadable", catalog: null },
    });
    expect(record.activities[0]?.gaps).toEqual([]);
    expect(record.activities[1]?.gaps.map((gap) => gap.kind)).toEqual(["no-consent-purpose"]);
    expect(record.gaps.map((gap) => gap.kind)).not.toContain("phi-not-covered");
    expect(record.notDerivable.join(" ")).toMatch(/catalog/);
  });

  test("without field names, a gap names the capability and the class, and no table or path", () => {
    const record = derive({
      fieldNames: false,
      inventory: inventory([
        users,
        schema("clinic", "patients", [
          ["history", "phi"],
          ["notes", "phi"],
        ]),
        schema("clinic", "visits", [["reason", "phi"]]),
      ]),
    });
    expect(record.gaps.filter((gap) => gap.kind === "phi-not-covered")).toEqual([
      { kind: "phi-not-covered", subject: "clinic", detail: expect.any(String) },
    ]);
    const unclaimed = record.gaps.find((gap) => gap.kind === "class-unclaimed");
    expect(unclaimed).toEqual({ kind: "class-unclaimed", subject: "clinic", detail: expect.stringContaining("phi") });
    expect(JSON.stringify(record)).not.toMatch(/patients|visits|history|notes|reason/);
  });

  test("recipients: Cloudflare always, a binding's on its capability's activities, and an activity's own", () => {
    const paid: ResolvedActivity = {
      ...account,
      id: "payments.purchases",
      classes: ["pii"],
      declaredBy: "payments",
      recipients: [{ name: "Stripe", receives: "The buyer's email address.", classes: ["pii"] }],
    };
    const ai = { name: "Cloudflare Workers AI", receives: "Text to embed.", classes: [], capability: "payments" };
    const record = derive({ activities: [account, paid], bindingRecipients: [ai] });
    expect(record.activities[1]?.recipients.map((recipient) => [recipient.name, recipient.source])).toEqual([
      ["Cloudflare", "platform"],
      ["Cloudflare Workers AI", "binding"],
      ["Stripe", "declared"],
    ]);
    expect(record.activities[0]?.recipients.map((recipient) => recipient.name)).toEqual(["Cloudflare"]);
    expect(record.recipients.map((recipient) => recipient.name)).toEqual([
      "Cloudflare",
      "Cloudflare Workers AI",
      "Stripe",
    ]);
    expect(record.recipients[0]?.classes).toEqual(["pii"]);
  });

  test("the record lists a recipient two activities share once, and each activity still lists it", () => {
    const sender = { name: "Cloudflare Email Service", receives: "The recipient's address.", classes: ["pii"] };
    const delivery: ResolvedActivity = { ...account, id: "email.delivery", declaredBy: "email", recipients: [sender] };
    const marketing: ResolvedActivity = {
      ...account,
      id: "email.marketing",
      declaredBy: "email",
      recipients: [sender],
    };
    const ai = { name: "Cloudflare Workers AI", receives: "Text to embed.", classes: [], capability: "vector" };
    const record = derive({
      activities: [delivery, marketing],
      bindingRecipients: [ai, { ...ai, capability: "support" }],
    });
    expect(record.recipients.map((recipient) => [recipient.name, recipient.source])).toEqual([
      ["Cloudflare", "platform"],
      ["Cloudflare Workers AI", "binding"],
      ["Cloudflare Email Service", "declared"],
    ]);
    for (const activity of record.activities) {
      expect(activity.recipients.map((recipient) => recipient.name)).toEqual([
        "Cloudflare",
        "Cloudflare Email Service",
      ]);
    }
  });

  test("measures carry the evidence pack's state only where it was read", () => {
    expect(derive().measures.every((measure) => measure.state === null)).toBe(true);
    const states = Object.fromEntries(PROCESSING_MEASURES.map((control) => [control, "gap" as const]));
    expect(derive({ measures: states }).measures.every((measure) => measure.state === "gap")).toBe(true);
    expect(derive().measures.map((measure) => measure.control)).toEqual([...PROCESSING_MEASURES]);
  });

  test("with no retention recorded, an entry carries none", () => {
    expect(derive({ retention: null }).activities[0]?.retention).toBeNull();
  });

  test("every record parses with its exported schema", () => {
    const record = derive({ inventory: inventory([users, schema("clinic", "patients", [["history", "phi"]])]) });
    const full = { environment: "prod", generatedAt: "2026-10-28T00:00:00.000Z", version: null, ...record };
    expect(ControlPlaneProcessingResponse.parse(full)).toEqual(full);
  });
});

describe("workersAiRecipients", () => {
  const vector = { name: "vector", requiredBindings: [{ type: "ai", name: "AI", optional: false }] };

  test("names Workers AI for each capability whose ai binding is bound", () => {
    expect(workersAiRecipients([vector], { AI: {} })).toEqual([
      { name: "Cloudflare Workers AI", receives: expect.stringContaining("vector"), classes: [], capability: "vector" },
    ]);
  });

  test("names nothing when the binding is absent", () => {
    expect(workersAiRecipients([vector], {})).toEqual([]);
  });
});
