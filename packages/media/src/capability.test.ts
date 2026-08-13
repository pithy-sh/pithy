// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { isMediaCapability, MEDIA_MIGRATION_ORDER, media } from "./capability";
import { MEDIA_R2_SECRET, MEDIA_STORAGE_SECRET, mediaSecretsRegistry } from "./secret/registry";

/** Binding names a capability requires (ignoring optionality). */
function bindingNames(cap: ReturnType<typeof media>): string[] {
  return cap.requiredBindings.map((b) => b.name);
}

/** The migration local keys the capability contributes to the app database. */
function migrationKeys(cap: ReturnType<typeof media>): string[] {
  return Object.keys(cap.databases?.app?.migrations ?? {});
}

describe("media()", () => {
  test("is a media capability contributing config, migrations, routes, and bindings (D1 default)", () => {
    const cap = media();
    expect(cap.name).toBe("media");
    expect(isMediaCapability(cap)).toBe(true);
    expect(cap.dependsOn).toContain("secrets");
    expect(cap.secretRegistry).toBeDefined();
    expect(cap.routes).toBeTypeOf("function");
    // The D1 default contributes the app database with the one authored migration, hashes and records.
    expect(cap.databases?.app?.binding).toBe("DB");
    expect(cap.databases?.app?.migrationOrder).toBe(MEDIA_MIGRATION_ORDER);
    expect(migrationKeys(cap)).toEqual(["0001_init"]);
    expect(bindingNames(cap)).toContain("DB");
    expect(bindingNames(cap)).toContain("MEDIA_BUCKET");
    expect(bindingNames(cap)).toEqual(
      expect.arrayContaining([
        "MEDIA_IMAGE_TO_TEXT",
        "MEDIA_AUDIO_TRANSCRIBE",
        "MEDIA_VIDEO_TRANSCRIBE",
        "MEDIA_DOC_EXTRACT",
      ]),
    );
  });

  test("KV record store still requires DB (dedup hashes are always D1) and adds the MEDIA binding", () => {
    const cap = media({ recordStore: "kv" });
    // The app database exists in KV mode too — for the hash table.
    expect(cap.databases?.app?.binding).toBe("DB");
    // The same one migration, told not to create the record table.
    expect(migrationKeys(cap)).toEqual(["0001_init"]);
    expect(bindingNames(cap)).toContain("DB");
    expect(bindingNames(cap)).toContain("MEDIA");
  });

  test("an extension adds a generated 0002_extend migration and widens the effective schema", () => {
    const cap = media({ extend: z.object({ userId: z.string().describe("owner") }).describe("ext") });
    expect(migrationKeys(cap)).toEqual(["0001_init", "0002_extend"]);
    expect(cap.schema.shape).toHaveProperty("userId");
  });

  test("without an extension there is no 0002_extend migration", () => {
    expect(migrationKeys(media())).not.toContain("0002_extend");
  });

  test("rejects a kvMetadata field that is not a record field", () => {
    // A base field is fine.
    expect(() => media({ recordStore: "kv", kvMetadata: ["status"] })).not.toThrow();
    // An extension field is fine once declared.
    expect(() =>
      media({
        recordStore: "kv",
        extend: z.object({ userId: z.string().describe("o") }).describe("e"),
        kvMetadata: ["userId"],
      }),
    ).not.toThrow();
    // A typo / unknown field fails fast at construction.
    expect(() => media({ recordStore: "kv", kvMetadata: ["usreId"] })).toThrow(/unknown kvMetadata field/i);
  });
});

describe("pithy.manifest.json — declared secrets", () => {
  const manifest = CapabilityManifest.parse(
    JSON.parse(readFileSync(new URL("../pithy.manifest.json", import.meta.url), "utf8")),
  );

  test("every registry entry is in the manifest, and says where it comes from and how it is replaced", () => {
    // The gate this capability had none of, and it covers both entries — including the R2 bundle media
    // declares through storage's factory and never handles. A client reads the manifest without executing
    // this package, so a secret missing from it is one `pithy doctor` can only call *not set*.
    //
    // Stated as the invariant, never as a filtered comparison: an entry declaring neither axis drops off
    // both sides of a filtered comparison at once and passes green.
    const entries: [string, SecretRegistryEntry][] = Object.entries(mediaSecretsRegistry);
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

  test("both are obtained from Cloudflare, and only the token rolls itself", () => {
    // The two owners, and the reason rotation is declared per secret rather than per issuer. A scoped API
    // token is replaced by asking Cloudflare, which returns the successor; an R2 S3 access-key pair has
    // no such call, so a human makes the next one.
    const token = manifest.secrets.find((secret) => secret.name === MEDIA_STORAGE_SECRET);
    expect(token?.origin).toMatchObject({ kind: "obtained", issuer: "cloudflare" });
    expect(token?.rotation).toMatchObject({ kind: "provider", issuer: "cloudflare" });

    const r2 = manifest.secrets.find((secret) => secret.name === MEDIA_R2_SECRET);
    expect(r2?.origin).toMatchObject({ kind: "obtained", issuer: "cloudflare" });
    expect(r2?.rotation).toMatchObject({ kind: "manual", issuer: "cloudflare" });
  });

  test("the R2 entry is declared identically to storage's — one factory, so the two cannot drift", () => {
    // `aggregateSecretRegistries` refuses two capabilities declaring one name incompatibly. Both R2
    // entries come from `r2CredentialsRegistry`, so both axes arrive with them.
    expect(mediaSecretsRegistry[MEDIA_R2_SECRET]?.origin).toEqual(
      manifest.secrets.find((secret) => secret.name === MEDIA_R2_SECRET)?.origin,
    );
  });

  test("mints nothing — neither an Images token nor an access key can be invented", () => {
    expect(manifest.devSecrets).toEqual([]);
  });
});
