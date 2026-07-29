import { describe, expect, test } from "vitest";
import { isStorageCapability, STORAGE_MIGRATION_ORDER, storage } from "./capability";
import { STORAGE_R2_SECRET } from "./secret/registry";

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
