import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { scaffoldProject } from "../project/scaffold";
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
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-add-"));
  await scaffoldProject({ targetDir: dir, appName: "add-test" });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("addCapability", () => {
  test("registers the capability import and call in pithy.config.ts, keeping the marker", async () => {
    await addCapability({ projectDir: dir, manifest });

    const config = await readFile(join(dir, "pithy.config.ts"), "utf8");
    expect(config).toContain('import { auth } from "@pithy-sh/auth/src/index";');
    expect(config).toContain("auth(),");
    // The marker survives for the next add, after the new registration.
    expect(config.indexOf("auth(),")).toBeLessThan(config.indexOf("// pithy:capabilities"));
  });

  test("adds required bindings to every wrangler.jsonc environment, preserving comments", async () => {
    await addCapability({ projectDir: dir, manifest });

    const raw = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    expect(raw).toContain("The top level is the dev environment");

    const wrangler = parse(raw) as unknown as WranglerBindings;
    for (const stanza of [wrangler, wrangler.env.staging, wrangler.env.production]) {
      expect(stanza?.d1_databases).toEqual([{ binding: "DB" }]);
      expect(stanza?.kv_namespaces).toEqual([{ binding: "SESSIONS" }]);
    }
  });

  test("running it twice changes nothing", async () => {
    await addCapability({ projectDir: dir, manifest });
    const configOnce = await readFile(join(dir, "pithy.config.ts"), "utf8");
    const wranglerOnce = await readFile(join(dir, "wrangler.jsonc"), "utf8");

    await addCapability({ projectDir: dir, manifest });
    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toBe(configOnce);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(wranglerOnce);
  });

  test("a config without the managed-region marker fails with an action line", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default { capabilities: [] };\n");
    await expect(addCapability({ projectDir: dir, manifest })).rejects.toThrow(PithyError);
  });

  test("a capability whose name is a substring of an existing registration is still added", async () => {
    // Register `myauth` first; its `myauth(),` line must not satisfy the
    // idempotency check for `auth` (whose `auth(),` is a substring of it).
    await addCapability({
      projectDir: dir,
      manifest: CapabilityManifest.parse({ name: "myauth", package: "@pithy-sh/myauth", requiredBindings: [] }),
    });
    await addCapability({ projectDir: dir, manifest });

    const config = await readFile(join(dir, "pithy.config.ts"), "utf8");
    expect(config).toContain('import { auth } from "@pithy-sh/auth/src/index";');
    expect(config).toMatch(/^\s*auth\(\),$/m); // a real auth() line, not just the myauth() substring
  });
});
