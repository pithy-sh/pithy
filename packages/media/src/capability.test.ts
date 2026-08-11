// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { isMediaCapability, MEDIA_MIGRATION_ORDER, media } from "./capability";

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
