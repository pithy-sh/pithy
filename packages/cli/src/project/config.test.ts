// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  allCapabilities,
  loadProject,
  loadProjectCloudflare,
  loadWorkerConfig,
  projectCloudflareAccount,
  requireProjectName,
  resolveProjectName,
} from "./config";

// In-package temp dirs (not the OS tmpdir): vitest can only transform the
// TS config files it imports when they live under the project root.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", "..", ".smoke-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a worker at `apps/<name>/pithy.config.ts` and return its directory. */
async function writeWorkerConfig(name: string, source: string): Promise<string> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "pithy.config.ts"), source);
  return workerDir;
}

describe("loadProject", () => {
  test("a directory without pithy.config.ts points at pithy init", async () => {
    const error = await loadProject(dir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toContain("pithy init");
  });

  test("loads the project's identity and policy", async () => {
    await writeFile(
      join(dir, "pithy.config.ts"),
      'export default { name: "acme", seed: { includeExamples: true } };\n',
    );
    const config = await loadProject(dir);
    expect(config.name).toBe("acme");
    expect(config.seed?.includeExamples).toBe(true);
  });

  test("a config that omits seed defaults to no example seeds", async () => {
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    const config = await loadProject(dir);
    expect(config.seed?.includeExamples ?? false).toBe(false);
  });

  test("a config that can't be imported reports an actionable error, not a module-resolution stack", async () => {
    await writeFile(join(dir, "pithy.config.ts"), 'import "@pithy-sh/does-not-exist";\nexport default {};\n');
    const error = await loadProject(dir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toContain("dependencies");
  });
});

describe("loadWorkerConfig", () => {
  test("loads a worker's capabilities and composes its app last", async () => {
    const workerDir = await writeWorkerConfig(
      "api",
      'export default { capabilities: [{ name: "auth", requiredBindings: [] }], app: { name: "app", requiredBindings: [] } };\n',
    );
    const config = await loadWorkerConfig(workerDir);
    expect(allCapabilities(config).map((cap) => cap.name)).toEqual(["auth", "app"]);
  });

  test("a worker without a config points at pithy worker add", async () => {
    const workerDir = join(dir, "apps", "ghost");
    await mkdir(workerDir, { recursive: true });
    const error = await loadWorkerConfig(workerDir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toContain("pithy worker add");
  });

  test("a worker config that doesn't default-export { capabilities } fails with the expected shape", async () => {
    const workerDir = await writeWorkerConfig("bad", "export default { nope: true };\n");
    await expect(loadWorkerConfig(workerDir)).rejects.toThrow(/default-export/);
  });
});

describe("allCapabilities", () => {
  test("no app means libraries only", () => {
    const auth = defineCapability({ name: "auth", requiredBindings: [] });
    expect(allCapabilities({ capabilities: [auth] })).toEqual([auth]);
  });
});

describe("resolveProjectName", () => {
  test("prefers the configured name, kebab-normalized", async () => {
    expect(await resolveProjectName({ name: "Acme Corp" }, dir)).toBe("acme-corp");
  });

  test("falls back to the project directory's basename when no name and no workers are discoverable", async () => {
    const expected = basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    expect(await resolveProjectName({}, dir)).toBe(expected);
  });
});

describe("requireProjectName", () => {
  test("returns the configured name, kebab-normalized", () => {
    expect(requireProjectName({ name: "Acme Corp" })).toBe("acme-corp");
  });

  test("throws an actionable PithyError when `name` is absent — never guesses", () => {
    const error = ((): unknown => {
      try {
        requireProjectName({});
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("name");
    expect((error as PithyError).payload.action).toContain("name");
  });

  test("refuses a name the deploy-time namer would reject, so no command half-provisions under it", () => {
    // `1password-clone` used to sail through here: D1, KV, and R2 were created for real, `pithy migrate`
    // ran, and only then did the first host-worker deploy throw `core/internal`. It fails on the first
    // command instead, as a 400 the adopter can act on.
    const error = ((): unknown => {
      try {
        requireProjectName({ name: "1password-clone" });
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as PithyError).payload.status).toBe(400);
    expect((error as PithyError).payload.action).toContain("starting with a letter");
  });
});

/**
 * The `cloudflare` block: which account this project belongs to (#206). It is the one setting here that
 * reaches outside the checkout — `accountName` becomes a file name in the config directory — so it is
 * validated on load rather than trusted off the import, exactly as `domains` is.
 */
describe("the project's cloudflare block", () => {
  async function project(source: string): Promise<string> {
    // A fresh module specifier per test: `loadProject` imports the config live, and a Node module cache
    // hit would answer with the previous test's block.
    const projectDir = join(dir, `p${Math.random().toString(36).slice(2)}`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "pithy.config.ts"), source);
    return projectDir;
  }

  test("reads accountName and accountId, and publishes them for every later credential resolution", async () => {
    const dirA = await project(
      'export default { name: "acme", cloudflare: { accountName: "leed", accountId: "a1" } };\n',
    );
    const config = await loadProject(dirA);
    expect(loadProjectCloudflare(config)).toEqual({ accountName: "leed", accountId: "a1" });
    expect(await projectCloudflareAccount(dirA)).toEqual({ accountName: "leed", accountId: "a1" });
  });

  test("a project with no cloudflare block answers null, so cloudflare.json resolves as before", async () => {
    const dirA = await project('export default { name: "acme" };\n');
    expect(loadProjectCloudflare(await loadProject(dirA))).toBeUndefined();
    expect(await projectCloudflareAccount(dirA)).toBeNull();
  });

  test("an accountName that is not a bare token is refused on load, naming the config and the value", async () => {
    const dirA = await project('export default { name: "acme", cloudflare: { accountName: "../../etc/passwd" } };\n');
    const error = await loadProject(dirA).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    expect(`${payload.message} ${payload.detail ?? ""}`).toContain("cloudflare.accountName");
    expect(`${payload.message} ${payload.detail ?? ""}`).toContain("../../etc/passwd");
  });

  test.each([["a/b"], [""], ["Leed"], [".."]])("refuses the accountName %j on load", async (name) => {
    const dirA = await project(
      `export default { name: "acme", cloudflare: { accountName: ${JSON.stringify(name)} } };\n`,
    );
    await expect(loadProject(dirA)).rejects.toBeInstanceOf(PithyError);
  });

  test("a misspelled key is refused rather than ignored — a silently dropped pin is the fault, not a typo", async () => {
    const dirA = await project('export default { name: "acme", cloudflare: { accountid: "a1" } };\n');
    await expect(loadProject(dirA)).rejects.toBeInstanceOf(PithyError);
  });

  test("an accountId alone is legitimate: a single-account machine pinning the account it deploys to", async () => {
    const dirA = await project('export default { name: "acme", cloudflare: { accountId: "a1" } };\n');
    expect(loadProjectCloudflare(await loadProject(dirA))).toEqual({ accountId: "a1" });
    expect(await projectCloudflareAccount(dirA)).toEqual({ accountId: "a1" });
  });
});
