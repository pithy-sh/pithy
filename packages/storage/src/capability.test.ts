// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { isStorageCapability, STORAGE_MIGRATION_ORDER, storage } from "./capability";
import { STORAGE_R2_SECRET, storageSecretsRegistry } from "./secret/registry";

describe("storage capability", () => {
  test("exposes its name and resolved config", () => {
    const capability = storage({ quota: { bytesPerOwner: 1024 } });
    expect(capability.name).toBe("storage");
    expect(capability.storageConfig.quota.bytesPerOwner).toBe(1024);
    expect(isStorageCapability(capability)).toBe(true);
  });

  test("declares the D1 and R2 bindings it cannot run without, plus the sweep's optional one", () => {
    expect(storage().requiredBindings.map((b) => `${b.type}:${b.name}`)).toEqual([
      "d1:DB",
      "r2:STORAGE_BUCKET",
      "workflow:STORAGE_SWEEP",
    ]);
  });

  test("the sweep binding is optional, so a project that has not provisioned still boots", () => {
    const sweep = storage().requiredBindings.find((b) => b.name === "STORAGE_SWEEP");
    expect(sweep?.optional).toBe(true);
  });

  test("the manifest's requiredBindings match the capability's — nothing else checks that they do", async () => {
    const manifest = (await import("../pithy.manifest.json", { with: { type: "json" } })).default;
    expect(manifest.requiredBindings.map((b) => `${b.type}:${b.name}`)).toEqual(
      storage().requiredBindings.map((b) => `${b.type}:${b.name}`),
    );
  });

  test("mounts routes and contributes the example seed", () => {
    const capability = storage();
    expect(typeof capability.routes).toBe("function");
    expect(capability.seeds?.map((set) => set.name)).toEqual(["example"]);
  });

  test("registers the sweep as its one durable job, on a daily cron", () => {
    expect(Object.keys(storage().workflows ?? {})).toEqual(["sweep"]);
    expect(storage().workflows?.sweep?.schedule).toBe("0 3 * * *");
  });

  test("declares the R2 credential secret, so the seam can resolve it through the aggregated registry", () => {
    expect(Object.keys(storage().secretRegistry ?? {})).toEqual([STORAGE_R2_SECRET]);
  });

  test("depends on secrets, and only on secrets — auth is a seam, so a missing auth denies rather than opens", () => {
    expect(storage().dependsOn).toEqual(["secrets"]);
  });

  test("sorts after matchmaking in the app database, on an order nothing else has taken", () => {
    expect(STORAGE_MIGRATION_ORDER).toBe(800);
    expect(storage().databases?.app?.migrationOrder).toBe(800);
    expect(Object.keys(storage().databases?.app?.migrations ?? {})).toEqual(["0001_objects"]);
  });

  test("rejects an impossible config at assembly, not on the first upload", () => {
    expect(() => storage({ partSizeBytes: 1024 })).toThrow();
    expect(() => storage({ multipartThresholdBytes: 10 * 1024 * 1024 })).toThrow();
  });
});

describe("pithy.manifest.json — declared secrets", () => {
  const manifest = CapabilityManifest.parse(
    JSON.parse(readFileSync(new URL("../pithy.manifest.json", import.meta.url), "utf8")),
  );

  test("every registry entry is in the manifest, and says where it comes from and how it is replaced", () => {
    // The gate this capability had none of. A client reads the manifest without executing this package,
    // so a declaration the manifest omits is one nothing downstream can act on — and an R2 key pair is
    // exactly the case the axes exist for: nothing will ever mint one, and saying where a human makes it
    // is the entire remedy the kit can offer.
    //
    // Stated as the invariant, never as a filtered comparison: building the expected list from entries
    // that declare both axes cannot fail for an entry declaring neither, which drops off both sides at
    // once and passes green.
    const entries: [string, SecretRegistryEntry][] = Object.entries(storageSecretsRegistry);
    expect(manifest.secrets.map((secret) => secret.name)).toEqual(entries.map(([name]) => name));
    for (const [name, entry] of entries) {
      expect(entry.origin, `${name} declares no origin`).toBeDefined();
      expect(entry.rotation, `${name} declares no rotation`).toBeDefined();
      expect(manifest.secrets.find((secret) => secret.name === name)).toEqual({
        name,
        origin: entry.origin,
        rotation: entry.rotation,
      });
    }
  });

  test("says a human makes the R2 pair at Cloudflare, and remakes it there — no API mints one", () => {
    const declared = manifest.secrets.find((secret) => secret.name === STORAGE_R2_SECRET);
    expect(declared?.origin).toMatchObject({ kind: "obtained", issuer: "cloudflare" });
    expect(declared?.rotation).toMatchObject({ kind: "manual", issuer: "cloudflare" });
  });

  test("mints nothing — a generated access key opens no bucket", () => {
    expect(manifest.devSecrets).toEqual([]);
  });
});
