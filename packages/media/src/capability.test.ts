import { describe, expect, test } from "vitest";
import { z } from "zod";
import { isMediaCapability, MEDIA_MIGRATION_ORDER, media } from "./capability";

/** Binding names a capability requires (ignoring optionality). */
function bindingNames(cap: ReturnType<typeof media>): string[] {
  return cap.requiredBindings.map((b) => b.name);
}

describe("media()", () => {
  test("is a media capability contributing config, migrations, routes, and bindings (D1 default)", () => {
    const cap = media();
    expect(cap.name).toBe("media");
    expect(isMediaCapability(cap)).toBe(true);
    expect(cap.dependsOn).toContain("secrets");
    expect(cap.secretRegistry).toBeDefined();
    expect(cap.routes).toBeTypeOf("function");
    // The D1 default contributes the app database with the base migration.
    expect(cap.databases?.app?.binding).toBe("DB");
    expect(cap.databases?.app?.migrationOrder).toBe(MEDIA_MIGRATION_ORDER);
    expect(Object.keys(cap.databases?.app?.migrations ?? {})).toEqual(["0001_init"]);
    expect(bindingNames(cap)).toContain("DB");
    expect(bindingNames(cap)).toContain("MEDIA_BUCKET");
    // The enrichment Workflow bindings are declared (optional).
    expect(bindingNames(cap)).toEqual(
      expect.arrayContaining([
        "MEDIA_IMAGE_TO_TEXT",
        "MEDIA_AUDIO_TRANSCRIBE",
        "MEDIA_VIDEO_TRANSCRIBE",
        "MEDIA_DOC_EXTRACT",
      ]),
    );
  });

  test("the KV record store contributes no database and requires the MEDIA binding", () => {
    const cap = media({ recordStore: "kv" });
    expect(cap.databases).toBeUndefined();
    expect(bindingNames(cap)).toContain("MEDIA");
    expect(bindingNames(cap)).not.toContain("DB");
  });

  test("an extension adds a generated 0002_extend migration and widens the effective schema", () => {
    const cap = media({ extend: z.object({ userId: z.string().describe("owner") }).describe("ext") });
    expect(Object.keys(cap.databases?.app?.migrations ?? {})).toEqual(["0001_init", "0002_extend"]);
    // The effective schema accepts the extension field.
    expect(cap.schema.shape).toHaveProperty("userId");
  });

  test("without an extension there is no 0002_extend migration", () => {
    const cap = media();
    expect(Object.keys(cap.databases?.app?.migrations ?? {})).not.toContain("0002_extend");
  });
});
