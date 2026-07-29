import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { addCapability } from "./add";

const manifest = CapabilityManifest.parse({
  name: "auth",
  package: "@pithy-sh/auth",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "kv", name: "SESSIONS" },
  ],
});

interface WranglerBindings {
  d1_databases: { binding: string }[];
  kv_namespaces: { binding: string }[];
  env: Record<string, { d1_databases: { binding: string }[]; kv_namespaces: { binding: string }[] }>;
}

let dir: string;
/** The Worker `pithy add` wires into. Capabilities are per-Worker, so this — never the project root. */
let worker: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-add-"));
  await scaffoldProject({ targetDir: dir, appName: "add-test" });
  worker = join(dir, "apps", DEFAULT_WORKER);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("addCapability", () => {
  test("registers the capability import and call in pithy.config.ts, keeping the marker", async () => {
    await addCapability({ workerDir: worker, manifest });

    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).toContain('import { auth } from "@pithy-sh/auth/src/index";');
    expect(config).toContain("auth(),");
    // The marker survives for the next add, after the new registration.
    expect(config.indexOf("auth(),")).toBeLessThan(config.indexOf("// pithy:capabilities"));
  });

  test("adds required bindings to every wrangler.jsonc environment, preserving comments", async () => {
    await addCapability({ workerDir: worker, manifest });

    const raw = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    expect(raw).toContain("The top level is the dev environment");

    const wrangler = parse(raw) as unknown as WranglerBindings;
    for (const stanza of [wrangler, wrangler.env.staging, wrangler.env.production]) {
      expect(stanza?.d1_databases).toEqual([{ binding: "DB" }]);
      expect(stanza?.kv_namespaces).toEqual([{ binding: "SESSIONS" }]);
    }
  });

  test("running it twice changes nothing", async () => {
    await addCapability({ workerDir: worker, manifest });
    const configOnce = await readFile(join(worker, "pithy.config.ts"), "utf8");
    const wranglerOnce = await readFile(join(worker, "wrangler.jsonc"), "utf8");

    await addCapability({ workerDir: worker, manifest });
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toBe(configOnce);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(wranglerOnce);
  });

  test("a config without the managed-region marker fails with an action line", async () => {
    await writeFile(join(worker, "pithy.config.ts"), "export default { capabilities: [] };\n");
    await expect(addCapability({ workerDir: worker, manifest })).rejects.toThrow(PithyError);
  });

  test("a durable_object capability wires the DO binding per env and the class migration tag top-level", async () => {
    const doManifest = CapabilityManifest.parse({
      name: "multiplayer",
      package: "@pithy-sh/multiplayer",
      requiredBindings: [
        { type: "durable_object", name: "SESSIONS", className: "MultiplayerSession" },
        { type: "d1", name: "DB" },
      ],
    });
    await addCapability({ workerDir: worker, manifest: doManifest });

    interface DoWrangler {
      d1_databases: { binding: string }[];
      durable_objects?: { bindings: { name: string; class_name: string }[] };
      migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
      env: Record<
        string,
        { durable_objects?: { bindings: { name: string; class_name: string }[] }; migrations?: unknown }
      >;
    }
    const wrangler = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as DoWrangler;

    // The DO binding is emitted into every environment (each gets its own namespace).
    for (const stanza of [wrangler, wrangler.env.staging, wrangler.env.production]) {
      expect(stanza?.durable_objects?.bindings).toEqual([{ name: "SESSIONS", class_name: "MultiplayerSession" }]);
    }
    // The D1 binding still rides the normal path.
    expect(wrangler.d1_databases).toEqual([{ binding: "DB" }]);

    // The class migration tag is top-level ONLY, and uses new_sqlite_classes (not new_classes).
    expect(wrangler.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["MultiplayerSession"] }]);
    expect(wrangler.env.staging?.migrations).toBeUndefined();
    expect(wrangler.env.production?.migrations).toBeUndefined();

    // Idempotent: a second add changes nothing.
    const once = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    await addCapability({ workerDir: worker, manifest: doManifest });
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(once);
  });

  test("wires only the target worker — a sibling's config and bindings are untouched", async () => {
    // A second worker, copied from the scaffolded one: same shape, different directory.
    const sibling = join(dir, "apps", "edge");
    await cp(worker, sibling, { recursive: true });

    await addCapability({ workerDir: worker, manifest });

    const siblingConfig = await readFile(join(sibling, "pithy.config.ts"), "utf8");
    expect(siblingConfig).not.toContain("@pithy-sh/auth");
    expect(siblingConfig).toContain("// pithy:capabilities");

    const siblingWrangler = parse(
      await readFile(join(sibling, "wrangler.jsonc"), "utf8"),
    ) as unknown as WranglerBindings;
    expect(siblingWrangler.d1_databases).toEqual([]);
    expect(siblingWrangler.kv_namespaces).toEqual([]);
    // And the target really was wired — the isolation isn't a no-op.
    const target = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as WranglerBindings;
    expect(target.d1_databases).toEqual([{ binding: "DB" }]);
  });

  test("a capability whose name is a substring of an existing registration is still added", async () => {
    // Register `myauth` first; its `myauth(),` line must not satisfy the
    // idempotency check for `auth` (whose `auth(),` is a substring of it).
    await addCapability({
      workerDir: worker,
      manifest: CapabilityManifest.parse({ name: "myauth", package: "@pithy-sh/myauth", requiredBindings: [] }),
    });
    await addCapability({ workerDir: worker, manifest });

    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).toContain('import { auth } from "@pithy-sh/auth/src/index";');
    expect(config).toMatch(/^\s*auth\(\),$/m); // a real auth() line, not just the myauth() substring
  });

  describe("config options", () => {
    const withOptions = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
      configOptions: [
        { key: "basePath", default: "/auth", describe: "Where the auth routes mount." },
        { key: "sessionDays", default: 30, describe: "Refresh-token lifetime in days." },
      ],
    });

    test("renders each option as key: default with its describe as a comment", async () => {
      await addCapability({ workerDir: worker, manifest: withOptions });

      const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
      expect(config).toContain("auth({");
      expect(config).toContain("// Where the auth routes mount.");
      expect(config).toContain('basePath: "/auth",');
      expect(config).toContain("// Refresh-token lifetime in days.");
      expect(config).toContain("sessionDays: 30,");
      expect(config).toContain("}),");
    });

    test("an override replaces the rendered default", async () => {
      await addCapability({
        workerDir: worker,
        manifest: withOptions,
        configValues: { basePath: "/authentication" },
      });

      const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
      expect(config).toContain('basePath: "/authentication",');
      expect(config).not.toContain('basePath: "/auth",');
      // Un-overridden options keep their default.
      expect(config).toContain("sessionDays: 30,");
    });

    test("running it twice with options changes nothing", async () => {
      await addCapability({ workerDir: worker, manifest: withOptions });
      const once = await readFile(join(worker, "pithy.config.ts"), "utf8");

      await addCapability({ workerDir: worker, manifest: withOptions });
      expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toBe(once);
    });
  });
});

describe("no hand-rolled comment-json round-trips in capabilities/", () => {
  test("no non-test file imports stringify from comment-json", async () => {
    const capDir = new URL(".", import.meta.url).pathname;
    const files = (await readdir(capDir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const file of files) {
      const content = await readFile(join(capDir, file), "utf8");
      // stringify from comment-json is only needed for the hand-rolled wrangler.jsonc round-trip.
      // All wrangler.jsonc writes go through writeWranglerConfig; no capabilities/ file needs stringify.
      expect(content, `${file} imports stringify from comment-json`).not.toMatch(
        /import\s*\{[^}]*\bstringify\b[^}]*\}\s*from\s*["']comment-json["']/,
      );
    }
  });
});
