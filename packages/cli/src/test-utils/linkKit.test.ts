// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hostConfigFile, hostEntryFile } from "../capabilities/hostFiles";
import { copyKitPackage, isDeployTransient } from "./linkKit";

/**
 * **A copy of a kit package never races a deploy of it (#711).** A kit deploy writes its resolved config and
 * generated entry beside the host's worker module and removes them in a `finally`. A suite copying that package
 * meanwhile listed the file, then `lstat`ed it after it was gone, and failed with `ENOENT` on a run nobody
 * changed. Those two files are never part of a package, so the copy passes over them by name, before it reads
 * them — which is what makes a vanishing one harmless.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-link-kit-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isDeployTransient", () => {
  test.each(["feature", "staging", "prod", "dev"])("names both files a %s deploy writes", (env) => {
    expect(isDeployTransient(hostConfigFile(env))).toBe(true);
    expect(isDeployTransient(hostEntryFile(env))).toBe(true);
  });

  test.each([
    "wrangler.jsonc",
    "wrangler.template.jsonc",
    "index.ts",
    "pithy.manifest.json",
    ".wrangler",
    ".wrangler.json",
    "x.wrangler.prod.json",
  ])("leaves %s alone", (name) => {
    expect(isDeployTransient(name)).toBe(false);
  });
});

/** A package with a worker module, and a deploy's two files beside it. */
async function packageWithTransients(): Promise<string> {
  const source = join(dir, "source");
  const workflows = join(source, "src", "workflows");
  await mkdir(workflows, { recursive: true });
  await writeFile(join(source, "package.json"), "{}\n");
  for (const name of ["a.ts", "b.ts", "c.ts", "worker.ts"]) await writeFile(join(workflows, name), "export {};\n");
  await writeFile(join(workflows, hostConfigFile("feature")), "{}\n");
  await writeFile(join(workflows, hostEntryFile("feature")), "export {};\n");
  return source;
}

describe("copyKitPackage", () => {
  test("copies the package and not a deploy's files", async () => {
    const source = await packageWithTransients();
    const target = join(dir, "target");
    await copyKitPackage(source, target);
    expect((await readdir(join(target, "src", "workflows"))).sort()).toEqual(["a.ts", "b.ts", "c.ts", "worker.ts"]);
    expect(await readdir(target)).toContain("package.json");
  });

  test("a deploy's file removed mid-copy is not an error", async () => {
    const source = await packageWithTransients();
    const transient = join(source, "src", "workflows", hostConfigFile("feature"));
    // The deploy's `finally`, landing after the directory was listed and before its entries are read.
    await copyKitPackage(source, join(dir, "target"), async (src) => {
      if (basename(src).endsWith(".ts")) await rm(transient, { force: true });
    });
    expect(await readdir(join(dir, "target", "src", "workflows"))).not.toContain(hostConfigFile("feature"));
  });

  test("the race is real: the same removal fails a copy that reads every entry", async () => {
    const source = await packageWithTransients();
    const transient = join(source, "src", "workflows", hostConfigFile("feature"));
    // Removed the moment the copy reaches the directory's first entry, so whichever order the listing came in,
    // the transient is listed and then gone.
    const copying = cp(source, join(dir, "target"), {
      recursive: true,
      filter: async (src) => {
        if (basename(src) !== "workflows" && src.includes(`${join("src", "workflows")}`)) {
          await rm(transient, { force: true });
        }
        return true;
      },
    });
    await expect(copying).rejects.toMatchObject({ code: "ENOENT" });
  });
});
