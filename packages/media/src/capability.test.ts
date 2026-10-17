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
  test("is a media capability contributing config, migrations, routes, and bindings", () => {
    const cap = media();
    expect(cap.name).toBe("media");
    expect(isMediaCapability(cap)).toBe(true);
    expect(cap.dependsOn).toContain("secrets");
    expect(cap.secretRegistry).toBeDefined();
    expect(cap.routes).toBeTypeOf("function");
    expect(cap.databases?.app?.binding).toBe("DB");
    expect(cap.databases?.app?.migrationOrder).toBe(MEDIA_MIGRATION_ORDER);
    expect(migrationKeys(cap)).toEqual(["0001_init", "0003_ownership"]);
    expect(bindingNames(cap)).toContain("DB");
    expect(bindingNames(cap)).toContain("MEDIA_BUCKET");
    // No KV namespace: records live in D1 and nowhere else.
    expect(bindingNames(cap)).not.toContain("MEDIA");
    expect(bindingNames(cap)).toEqual(
      expect.arrayContaining([
        "MEDIA_IMAGE_TO_TEXT",
        "MEDIA_AUDIO_TRANSCRIBE",
        "MEDIA_VIDEO_TRANSCRIBE",
        "MEDIA_DOC_EXTRACT",
      ]),
    );
  });

  test("a config naming the kv record store is refused with the remedy named, never booted", () => {
    expect(() => media({ recordStore: "kv" } as never)).toThrow(/`kv` media record store was removed/);
    expect(() => media({ kvMetadata: ["type"] } as never)).toThrow(/kvMetadata/);
  });

  test("declares media:manage, so tenancy can require a role to hold it once media is composed", () => {
    expect(media().powers).toEqual(["media:manage"]);
  });

  test("advertises its usage read at the resolved mount path", () => {
    expect(media({ basePath: "/files" }).adminRoutes).toEqual([
      expect.objectContaining({ method: "GET", path: "/files/admin/usage", scope: "media:usage:read" }),
    ]);
  });

  test("an extension adds a generated 0002_extend migration and widens the effective schema", () => {
    const cap = media({ extend: z.object({ album: z.string().describe("album") }).describe("ext") });
    expect(migrationKeys(cap)).toEqual(["0001_init", "0003_ownership", "0002_extend"]);
    expect(cap.schema.shape).toHaveProperty("album");
  });

  test("without an extension there is no 0002_extend migration", () => {
    expect(migrationKeys(media())).not.toContain("0002_extend");
  });

  test("declares the doctor check that names records outside a narrowed policy", async () => {
    const asked: string[] = [];
    const cap = media({ visibility: { allowed: ["private"] } });
    const findings = await cap.settings?.account?.({
      project: "acme",
      worker: "acme-api",
      workerDirectory: "api",
      environments: [{ name: "prod", origin: null }],
      account: {
        d1Databases: async () => [],
        zone: async () => true,
        vaultSecret: async () => true,
        storeEntry: async () => true,
        appRows: async (request) => {
          asked.push(`${request.table}:${request.values.join(",")}`);
          return ["m1"];
        },
      },
    });
    expect(asked).toEqual(["pithy_media_assets:organization,public"]);
    expect(findings?.[0]?.problem).toContain("m1");
  });

  test("a visibility default outside allowed is refused at boot", () => {
    expect(() => media({ visibility: { default: "public", allowed: ["private"] } })).toThrow();
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

  test("the credentials are obtained from Cloudflare, and only the token rolls itself", () => {
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
