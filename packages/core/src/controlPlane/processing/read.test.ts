// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import { describe, expect, test, vi } from "vitest";
import { type Capability, defineCapability, type PithyHonoEnv } from "../../capability/capability";
import { ConsentPurpose } from "../../consent/purpose";
import type { ConsentReader } from "../../consent/reader";
import type { PrivacyInventory } from "../../privacy/report";
import type { ControlPlaneContext } from "../context";
import type { ControlPlaneHandlerDeps } from "../http/handlers";
import { PRIVACY_READ_SCOPE, PROCESSING_READ_SCOPE } from "../scope/scope";
import { readProcessingRecord } from "./read";

/** How `readProcessingRecord` turns each reader and inventory it is handed into the record's inputs. */

const records = ConsentPurpose.parse({
  id: "clinic.records",
  summary: "Keep my health records.",
  noticeVersion: 2,
  classes: ["phi"],
});

const stored: PrivacyInventory = {
  sources: ["d1"],
  schemasWalked: 1,
  schemas: [
    {
      capability: "clinic",
      storage: "d1",
      container: "app",
      name: "clinicPatients",
      fields: [{ path: "history", class: "phi" }],
      encrypted: [],
    },
  ],
  counts: {},
  observed: ["phi"],
  encryptedFields: 0,
  unrotatable: 0,
};

const clinic = defineCapability({
  name: "clinic",
  requiredBindings: [],
  processing: [
    {
      id: "clinic.care",
      purpose: "Treat patients.",
      classes: ["phi"],
      legalBasis: "consent",
      consentPurpose: "clinic.records",
    },
  ],
});

function consentWith(reader: ConsentReader): Capability {
  return defineCapability({ name: "consent", requiredBindings: [], consentReader: () => reader });
}

function run(capabilities: Capability[], inventory: () => PrivacyInventory = () => stored) {
  const warn = vi.fn();
  const c = { env: {}, var: { log: { warn } } } as unknown as Context<PithyHonoEnv>;
  const deps = {
    composition: () => capabilities,
    privacyInventory: inventory,
    now: () => new Date("2026-10-01T00:00:00Z"),
  } as unknown as ControlPlaneHandlerDeps;
  const context = {
    environment: "prod",
    grantedScopes: [PROCESSING_READ_SCOPE, PRIVACY_READ_SCOPE],
  } as unknown as ControlPlaneContext;
  return { warn, record: readProcessingRecord(c, deps, context) };
}

const CATALOG_UNLISTED = /consent catalog could not be listed/;

describe("readProcessingRecord", () => {
  test("a reader with only hasConsent lists no catalog, so no gap rests on one and notDerivable says so", async () => {
    const { record } = run([clinic, consentWith({ hasConsent: async () => false })]);
    const body = await record;
    const kinds = [...body.gaps, ...body.activities.flatMap((activity) => activity.gaps)].map((gap) => gap.kind);
    expect(kinds).not.toContain("no-consent-purpose");
    expect(kinds).not.toContain("phi-not-covered");
    expect(body.notDerivable.join(" ")).toMatch(/consent record could not be read/);
    expect(body.notDerivable.join(" ")).toMatch(CATALOG_UNLISTED);
  });

  test("a catalog that throws is logged and reads as no catalog", async () => {
    const { record, warn } = run([
      clinic,
      consentWith({
        hasConsent: async () => false,
        purposes: () => {
          throw new Error("catalog unavailable");
        },
      }),
    ]);
    const body = await record;
    const kinds = [...body.gaps, ...body.activities.flatMap((activity) => activity.gaps)].map((gap) => gap.kind);
    expect(kinds).not.toContain("no-consent-purpose");
    expect(kinds).not.toContain("phi-not-covered");
    expect(body.notDerivable.join(" ")).toMatch(CATALOG_UNLISTED);
    expect(warn).toHaveBeenCalledWith("processing: consent catalog unreadable", { reason: "catalog unavailable" });
  });

  test("a reader with a catalog and no standings still cites the purpose, with null counts", async () => {
    const { record } = run([clinic, consentWith({ hasConsent: async () => false, purposes: () => [records] })]);
    const body = await record;
    const care = body.activities.find((activity) => activity.id === "clinic.care");
    expect(care?.consent).toMatchObject({ purpose: "clinic.records", noticeVersion: 2, grants: null, standing: null });
    expect(care?.gaps).toEqual([]);
    expect(body.gaps.map((gap) => gap.kind)).not.toContain("phi-not-covered");
    expect(body.notDerivable.join(" ")).toMatch(/consent record could not be read/);
    expect(body.notDerivable.join(" ")).not.toMatch(CATALOG_UNLISTED);
  });

  test("an inventory walk that throws is logged, and the record still answers without it", async () => {
    const { record, warn } = run([clinic], () => {
      throw new Error("walk failed");
    });
    const body = await record;
    expect(body.activities.map((activity) => activity.id)).toEqual(["clinic.care"]);
    expect(body.gaps.map((gap) => gap.kind)).not.toContain("phi-not-covered");
    expect(body.notDerivable.join(" ")).toMatch(/privacy inventory could not be walked/);
    expect(warn).toHaveBeenCalledWith("processing: privacy inventory unreadable", { reason: "walk failed" });
  });
});
