// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test } from "vitest";
import type { AvailableManifests } from "../capabilities/manifests";
import type { ResolvedWorker } from "../project/workerScope";
import { removeTempDir } from "../test-utils/tempRepo";
import { checkProject } from "./check";

/**
 * **`pithy setup` checks the project before it writes anything after the install.** The config parses,
 * every capability a Worker composes is installed, every Worker composes. A failure is the end of the run,
 * named, because nothing after it can work.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

async function project(rootConfig = `export default { name: "checked" };\n`): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-setup-check-"));
  dirs.push(dir);
  await writeFile(join(dir, "pithy.config.ts"), rootConfig);
  return dir;
}

/** The set of one Worker composing `names`. */
function resolution(dir: string, names: string[]): ResolvedWorker[] {
  const capabilities = names.map((name) => defineCapability({ name, requiredBindings: [] }));
  return [
    {
      name: "api",
      dir: join(dir, "apps", "api"),
      config: { capabilities },
      capabilities,
      target: { name: "api", dir: join(dir, "apps", "api") },
    },
  ];
}

function manifest(name: string, peerCapabilities: string[] = []): CapabilityManifest {
  return CapabilityManifest.parse({ name, package: `@pithy-sh/${name}`, requiredBindings: [], peerCapabilities });
}

async function failureOf(run: Promise<unknown>): Promise<PithyError> {
  const failure = await run.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(failure instanceof PithyError)) throw new Error(`expected a PithyError, got ${String(failure)}`);
  return failure;
}

describe("checkProject", () => {
  test("a project whose Workers compose and whose peers are composed passes, naming the project", async () => {
    const dir = await project();
    const manifests: AvailableManifests = {
      manifests: [manifest("secrets"), manifest("email", ["secrets"])],
      faults: [],
    };

    const checked = await checkProject({
      projectDir: dir,
      resolve: async () => resolution(dir, ["secrets", "email"]),
      manifests: async () => manifests,
    });

    expect(checked.project).toBe("checked");
    expect(checked.workers.map((worker) => worker.name)).toEqual(["api"]);
  });

  test("no root config is refused as not a project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-setup-check-"));
    dirs.push(dir);

    const failure = await failureOf(checkProject({ projectDir: dir }));

    expect(failure.payload.message).toBe("No pithy.config.ts here.");
  });

  test("a root config with no name is refused, before any Worker is read", async () => {
    const dir = await project("export default {};\n");
    let read = false;

    const failure = await failureOf(
      checkProject({
        projectDir: dir,
        resolve: async () => {
          read = true;
          return resolution(dir, []);
        },
      }),
    );

    expect(failure.payload.message).toBe("pithy.config.ts has no `name`.");
    expect(read).toBe(false);
  });

  test("a Worker whose pithy.config.ts is missing stops the run, named", async () => {
    const dir = await project();

    const failure = await failureOf(
      checkProject({
        projectDir: dir,
        resolve: async () => ({ unknown: "No pithy.config.ts in web — every worker under apps/ needs one." }),
        manifests: async () => ({ manifests: [], faults: [] }),
      }),
    );

    expect(failure.payload.message).toBe("The project check failed, so setup stopped before writing anything.");
    expect(failure.payload.action).toContain("No pithy.config.ts in web — every worker under apps/ needs one.");
  });

  test("a composed capability missing its peer stops the run, naming both", async () => {
    const dir = await project();

    const failure = await failureOf(
      checkProject({
        projectDir: dir,
        resolve: async () => resolution(dir, ["email"]),
        manifests: async () => ({ manifests: [manifest("email", ["secrets"])], faults: [] }),
      }),
    );

    expect(failure.payload.action).toContain("api composes email, which requires secrets.");
  });

  test("an installed manifest that cannot be used stops the run, naming the package", async () => {
    const dir = await project();

    const failure = await failureOf(
      checkProject({
        projectDir: dir,
        resolve: async () => resolution(dir, []),
        manifests: async () => ({
          manifests: [],
          faults: [{ package: "@pithy-sh/audit", file: "pithy.manifest.json", reason: "not JSON" }],
        }),
      }),
    );

    expect(failure.payload.action).toContain(
      "@pithy-sh/audit has a pithy.manifest.json that cannot be used: not JSON.",
    );
  });

  test("a Worker config that will not load stops the run with the loader's own sentence", async () => {
    const dir = await project();
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "wrangler.jsonc"), `{ "name": "checked-api" }\n`);
    await writeFile(
      join(dir, "apps", "api", "pithy.config.ts"),
      `import "@pithy-sh/not-installed";\nexport default { capabilities: [] };\n`,
    );

    const failure = await failureOf(checkProject({ projectDir: dir }));

    expect(failure.payload.message).not.toBe("");
    expect(`${failure.payload.message} ${failure.payload.action ?? ""}`).toContain("@pithy-sh/not-installed");
  });
});
