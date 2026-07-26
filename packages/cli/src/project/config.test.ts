import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { allCapabilities, loadProject, requireProjectName, resolveProjectName } from "./config";

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

describe("ProjectConfig.seed", () => {
  test("loads a config with seed.includeExamples set", async () => {
    await writeFile(
      join(dir, "pithy.config.ts"),
      "export default { capabilities: [], seed: { includeExamples: true } };\n",
    );
    const config = await loadProject(dir);
    expect(config.seed?.includeExamples).toBe(true);
  });

  test("a config that omits seed defaults to no example seeds", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default { capabilities: [] };\n");
    const config = await loadProject(dir);
    expect(config.seed?.includeExamples ?? false).toBe(false);
  });
});

describe("resolveProjectName", () => {
  test("prefers the configured name, kebab-normalized", async () => {
    expect(await resolveProjectName({ capabilities: [], name: "Acme Corp" }, dir)).toBe("acme-corp");
  });

  test("falls back to the project directory's basename when no name and no workers are discoverable", async () => {
    const expected = basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    expect(await resolveProjectName({ capabilities: [] }, dir)).toBe(expected);
  });
});

describe("requireProjectName", () => {
  test("returns the configured name, kebab-normalized", () => {
    expect(requireProjectName({ capabilities: [], name: "Acme Corp" })).toBe("acme-corp");
  });

  test("throws an actionable PithyError when `name` is absent — never guesses", () => {
    const error = ((): unknown => {
      try {
        requireProjectName({ capabilities: [] });
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("name");
    expect((error as PithyError).payload.action).toContain("name");
  });
});
