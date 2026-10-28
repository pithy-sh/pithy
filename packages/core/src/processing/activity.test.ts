// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defineCapability } from "../capability/capability";
import {
  activityDomain,
  type ProcessingActivityInput,
  parseProcessingActivities,
  parseProcessingPolicy,
  resolveProcessing,
} from "./activity";

const activity = (id: string, extra: Partial<ProcessingActivityInput> = {}): ProcessingActivityInput => ({
  id,
  purpose: "Keep an account and sign its holder in.",
  ...extra,
});

describe("parseProcessingActivities", () => {
  test("fills the defaults an activity may leave out, and leaves the legal basis unset when none is given", () => {
    const [parsed] = parseProcessingActivities("auth", [activity("auth.account", { classes: ["pii"] })], "auth");
    expect(parsed).toEqual({
      id: "auth.account",
      purpose: "Keep an account and sign its holder in.",
      classes: ["pii"],
      recipients: [],
    });
  });

  test("refuses an activity outside the declaring capability's domain", () => {
    expect(() => parseProcessingActivities("auth", [activity("email.account")], "auth")).toThrow(
      /outside its own domain/,
    );
  });

  test("refuses an adopter activity under a domain a composed capability owns", () => {
    expect(() =>
      parseProcessingActivities("pithy.config.ts", [activity("auth.extra")], null, new Set(["auth"])),
    ).toThrow(/a composed capability owns/);
    expect(
      parseProcessingActivities("pithy.config.ts", [activity("clinic.intake")], null, new Set(["auth"])),
    ).toHaveLength(1);
  });

  test("refuses a duplicate id and a malformed one", () => {
    expect(() => parseProcessingActivities("auth", [activity("auth.a"), activity("auth.a")], "auth")).toThrow(/twice/);
    expect(() => parseProcessingActivities("auth", [activity("Auth Account")], "auth")).toThrow(/not valid/);
  });

  test("refuses a consent purpose on an activity whose basis is not consent", () => {
    expect(() =>
      parseProcessingActivities(
        "email",
        [activity("email.marketing", { legalBasis: "contract", consentPurpose: "email.marketing" })],
        "email",
      ),
    ).toThrow(/not valid/);
    expect(
      parseProcessingActivities(
        "email",
        [activity("email.marketing", { legalBasis: "consent", consentPurpose: "email.marketing" })],
        "email",
      )[0]?.consentPurpose,
    ).toBe("email.marketing");
  });

  test("the domain is everything before the first dot", () => {
    expect(activityDomain("clinic.records.intake")).toBe("clinic");
  });
});

describe("defineCapability", () => {
  test("parses a capability's activities and refuses one outside its domain where it is written", () => {
    const declared = defineCapability({
      name: "auth",
      requiredBindings: [],
      processing: [activity("auth.account", { legalBasis: "contract" })],
    });
    expect(declared.processing?.[0]).toMatchObject({ id: "auth.account", legalBasis: "contract", classes: [] });
    expect(() =>
      defineCapability({ name: "auth", requiredBindings: [], processing: [activity("email.account")] }),
    ).toThrow(/outside its own domain/);
  });
});

describe("parseProcessingPolicy", () => {
  test("an absent block is the empty policy", () => {
    expect(parseProcessingPolicy(undefined)).toEqual({});
  });

  test("refuses a block that does not parse, naming the config", () => {
    expect(() => parseProcessingPolicy({ activities: "none" })).toThrow(/processing block in pithy.config.ts/);
    expect(() => parseProcessingPolicy({ extra: true })).toThrow(/processing block in pithy.config.ts/);
  });

  test("refuses an override that names a consent purpose under a basis that is not consent", () => {
    expect(() =>
      parseProcessingPolicy({
        overrides: { "auth.account": { legalBasis: "contract", consentPurpose: "app.accounts" } },
      }),
    ).toThrow(/processing block in pithy.config.ts/);
  });
});

describe("resolveProcessing", () => {
  const auth = defineCapability({
    name: "auth",
    requiredBindings: [],
    processing: [activity("auth.account", { classes: ["pii"], legalBasis: "contract" })],
  });
  const vague = defineCapability({
    name: "vague",
    requiredBindings: [],
    processing: [activity("vague.things", { purpose: "Do things." })],
  });

  test("lists every capability's activities, in composition order, with who declared each and where its basis came from", () => {
    expect(resolveProcessing({}, [auth, vague])).toEqual([
      {
        id: "auth.account",
        purpose: "Keep an account and sign its holder in.",
        classes: ["pii"],
        legalBasis: "contract",
        basisSource: "capability",
        consentPurpose: null,
        recipients: [],
        declaredBy: "auth",
      },
      {
        id: "vague.things",
        purpose: "Do things.",
        classes: [],
        legalBasis: null,
        basisSource: null,
        consentPurpose: null,
        recipients: [],
        declaredBy: "vague",
      },
    ]);
  });

  test("adds the adopter's own activities after them, declared by the config", () => {
    const policy = parseProcessingPolicy({
      activities: [activity("clinic.intake", { purpose: "Take a patient's history.", classes: ["phi"] })],
    });
    const resolved = resolveProcessing(policy, [auth]);
    expect(resolved.map((entry) => [entry.id, entry.declaredBy, entry.legalBasis])).toEqual([
      ["auth.account", "auth", "contract"],
      ["clinic.intake", "config", null],
    ]);
  });

  test("an override replaces a capability's legal basis and says the config set it", () => {
    const policy = parseProcessingPolicy({
      overrides: { "auth.account": { legalBasis: "consent", consentPurpose: "clinic.accounts" } },
    });
    const [account] = resolveProcessing(policy, [auth]);
    expect(account).toMatchObject({ legalBasis: "consent", basisSource: "config", consentPurpose: "clinic.accounts" });
  });

  test("an override to a basis other than consent drops the consent purpose the capability named", () => {
    const consented = defineCapability({
      name: "email",
      requiredBindings: [],
      processing: [activity("email.marketing", { legalBasis: "consent", consentPurpose: "email.marketing" })],
    });
    const policy = parseProcessingPolicy({ overrides: { "email.marketing": { legalBasis: "legitimate-interests" } } });
    expect(resolveProcessing(policy, [consented])[0]).toMatchObject({
      legalBasis: "legitimate-interests",
      consentPurpose: null,
    });
  });

  test("an override to consent keeps the consent purpose the capability named when it names none", () => {
    const consented = defineCapability({
      name: "email",
      requiredBindings: [],
      processing: [activity("email.marketing", { legalBasis: "consent", consentPurpose: "email.marketing" })],
    });
    const policy = parseProcessingPolicy({ overrides: { "email.marketing": { legalBasis: "consent" } } });
    expect(resolveProcessing(policy, [consented])[0]?.consentPurpose).toBe("email.marketing");
  });

  test("refuses an override for an activity nothing composed declares", () => {
    const policy = parseProcessingPolicy({ overrides: { "ghost.thing": { legalBasis: "contract" } } });
    expect(() => resolveProcessing(policy, [auth])).toThrow(/ghost\.thing.*no composed capability declares/);
  });

  test("refuses an override of the adopter's own activity, which states its basis where it is declared", () => {
    const policy = parseProcessingPolicy({
      activities: [activity("clinic.intake")],
      overrides: { "clinic.intake": { legalBasis: "contract" } },
    });
    expect(() => resolveProcessing(policy, [auth])).toThrow(/clinic\.intake.*declared in the same block/);
  });

  test("refuses an adopter activity under a composed capability's domain", () => {
    const policy = parseProcessingPolicy({ activities: [activity("auth.mine")] });
    expect(() => resolveProcessing(policy, [auth])).toThrow(/a composed capability owns/);
  });
});
