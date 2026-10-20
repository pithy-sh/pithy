// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { phi, pii } from "@pithy-sh/core/src/privacy/classes";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { candidateClass, scanCapabilities } from "./scan";

describe("candidateClass", () => {
  test("reads a field's name as private the way a reviewer would", () => {
    expect(candidateClass("email")).toBe("pii");
    expect(candidateClass("contactEmail")).toBe("pii");
    expect(candidateClass("phone_number")).toBe("pii");
    expect(candidateClass("ipAddress")).toBe("pii");
    expect(candidateClass("dateOfBirth")).toBe("pii");
    expect(candidateClass("ssn")).toBe("pii");
    expect(candidateClass("diagnosis")).toBe("phi");
    expect(candidateClass("cardNumber")).toBe("pci");
    expect(candidateClass("resetToken")).toBe("secret");
    expect(candidateClass("passwordHash")).toBe("secret");
  });

  test("leaves an ordinary name alone, and does not match a fragment inside a word", () => {
    expect(candidateClass("id")).toBeNull();
    expect(candidateClass("createdAt")).toBeNull();
    expect(candidateClass("ownership")).toBeNull();
    expect(candidateClass("tokenCount")).toBeNull();
  });
});

const Patient = z
  .object({
    id: z.string().describe("id"),
    email: z.string().describe("Unmarked, and should be."),
    diagnosis: phi(z.string().describe("Marked already.")),
    profile: sqliteJson(z.object({ phone: z.string(), city: z.string() })).describe("A JSON column."),
  })
  .describe("A patient.");

const app = defineCapability({
  name: "app",
  requiredBindings: [],
  databases: { app: { binding: "DB", tables: { patients: Patient } } },
  kvNamespaces: {
    cache: {
      binding: "CACHE",
      stores: {
        lookups: { prefix: "app", key: z.object({ email: pii(z.string()) }), value: z.object({ ip: z.string() }) },
      },
    },
  },
});

describe("scanCapabilities", () => {
  test("reports an unmarked email as a pii candidate with the marker to apply, and a marked field as covered", () => {
    const findings = scanCapabilities("api", [app]);
    expect(findings).toContainEqual({
      worker: "api",
      capability: "app",
      owner: "app",
      storage: "d1",
      container: "app",
      schema: "patients",
      path: "email",
      status: "candidate",
      class: "pii",
      marker: "pii(…)",
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ schema: "patients", path: "diagnosis", status: "covered", class: "phi" }),
    );
    expect(findings).toContainEqual(expect.objectContaining({ path: "profile.phone", status: "candidate" }));
    expect(findings).toContainEqual(expect.objectContaining({ path: "key.email", status: "covered", class: "pii" }));
    expect(findings).toContainEqual(expect.objectContaining({ path: "value.ip", status: "candidate", class: "pii" }));
    expect(findings.find((finding) => finding.path === "id")).toBeUndefined();
  });

  test("says a kit capability's field is the kit's to mark", () => {
    const kit = defineCapability({
      name: "auth",
      version: "1.0.0",
      requiredBindings: [],
      databases: { app: { binding: "DB", tables: { users: z.object({ email: z.string() }) } } },
    });
    expect(scanCapabilities("api", [kit])[0]).toMatchObject({ owner: "kit", status: "candidate", path: "email" });
  });
});
