// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { PrivacyInventory } from "./inventory";
import { PRIVACY_ATTESTATION_VAR, type PrivacyAttestation, privacyAttestation, privacyPosture } from "./posture";

const inventory: PrivacyInventory = {
  sources: ["d1", "kv"],
  schemasWalked: 3,
  schemas: [
    {
      capability: "app",
      storage: "d1",
      container: "app",
      name: "patients",
      fields: [
        { path: "email", class: "pii" },
        { path: "diagnosis", class: "phi" },
      ],
    },
  ],
  counts: { pii: 1, phi: 1 },
  observed: ["pii", "phi"],
};

const attested: PrivacyAttestation = {
  classes: ["pii", "pci"],
  consoleGate: "enforced",
  reason: null,
  attestedAt: "2026-10-20T12:00:00.000Z",
};

describe("privacyAttestation", () => {
  test("reads the var `pithy deploy` writes", () => {
    expect(privacyAttestation({ [PRIVACY_ATTESTATION_VAR]: JSON.stringify(attested) })).toEqual(attested);
  });

  test("is null when no var reached the Worker, and for anything that is not one", () => {
    expect(privacyAttestation({})).toBeNull();
    expect(privacyAttestation(undefined)).toBeNull();
    expect(privacyAttestation({ [PRIVACY_ATTESTATION_VAR]: "not json" })).toBeNull();
    expect(privacyAttestation({ [PRIVACY_ATTESTATION_VAR]: JSON.stringify({ classes: "pii" }) })).toBeNull();
  });

  test("accepts the var already parsed, as wrangler hands a JSON var", () => {
    expect(privacyAttestation({ [PRIVACY_ATTESTATION_VAR]: attested })).toEqual(attested);
  });
});

describe("privacyPosture", () => {
  test("reports declared and observed side by side, and the delta both ways", () => {
    expect(privacyPosture(attested, () => inventory)).toEqual({
      declared: ["pii", "pci"],
      observed: ["pii", "phi"],
      counts: { pii: 1, phi: 1 },
      observedNotDeclared: ["phi"],
      declaredNotObserved: ["pci"],
      consoleGate: "enforced",
      consoleGateReason: null,
      attestedAt: "2026-10-20T12:00:00.000Z",
      sources: ["d1", "kv"],
    });
  });

  test("says explicitly that a project declared nothing, and walks nothing to say it", () => {
    const none: PrivacyAttestation = {
      classes: [],
      consoleGate: "not_required",
      reason: null,
      attestedAt: attested.attestedAt,
    };
    let walks = 0;
    const posture = privacyPosture(none, () => {
      walks += 1;
      return inventory;
    });
    expect(walks).toBe(0);
    expect(posture).toEqual({
      declared: [],
      observed: null,
      counts: null,
      observedNotDeclared: null,
      declaredNotObserved: null,
      consoleGate: "not_required",
      consoleGateReason: null,
      attestedAt: attested.attestedAt,
      sources: [],
    });
  });

  test("says a Worker carries no attestation, rather than inventing a declaration", () => {
    expect(privacyPosture(null, () => inventory)).toMatchObject({
      declared: null,
      consoleGate: "unattested",
      consoleGateReason: null,
      attestedAt: null,
      observed: ["pii", "phi"],
      observedNotDeclared: ["pii", "phi"],
      declaredNotObserved: [],
    });
  });

  test("carries an unverifiable gate's reason", () => {
    const unverifiable: PrivacyAttestation = {
      ...attested,
      consoleGate: "unverifiable",
      reason: "No biome.json or biome.jsonc at the project root.",
    };
    expect(privacyPosture(unverifiable, () => inventory)).toMatchObject({
      consoleGate: "unverifiable",
      consoleGateReason: "No biome.json or biome.jsonc at the project root.",
    });
  });
});
