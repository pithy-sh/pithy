import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { allCapabilities, loadProject } from "./config";

// In-package temp dirs (not the OS tmpdir): vitest can only transform the
// TS config files it imports when they live under the project root.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", "..", ".smoke-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadProject", () => {
  test("a directory without pithy.config.ts points at pithy init", async () => {
    const error = await loadProject(dir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toContain("pithy init");
  });

  test("a config that doesn't default-export { capabilities } fails with the expected shape", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default { nope: true };\n");
    await expect(loadProject(dir)).rejects.toThrow(PithyError);
    await expect(loadProject(dir)).rejects.toThrow(/default-export/);
  });

  test("loads the config and composes the app last", async () => {
    await writeFile(
      join(dir, "pithy.config.ts"),
      'export default { capabilities: [{ name: "auth", requiredBindings: [] }], app: { name: "app", requiredBindings: [] } };\n',
    );
    const config = await loadProject(dir);
    expect(allCapabilities(config).map((cap) => cap.name)).toEqual(["auth", "app"]);
  });
});

describe("allCapabilities", () => {
  test("no app means libraries only", () => {
    const auth = defineCapability({ name: "auth", requiredBindings: [] });
    expect(allCapabilities({ capabilities: [auth] })).toEqual([auth]);
  });
});
