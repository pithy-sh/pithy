// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { privacyVarArgs } from "../privacy/deployGate";
import { DEPLOY_STAMP_VAR } from "../provision/deployStamp";
import { appBundleStamp, bundleArgs, shadowBundlePaths, stampArgs } from "./appBundleStamp";

let root: string;
let worker: string;
let outdir: string;

const ARGS = ["deploy", "--env", "prod", "--experimental-provision=false"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pithy-bundle-stamp-"));
  worker = join(root, "apps", "web");
  outdir = join(root, "out");
  await mkdir(worker, { recursive: true });
  await mkdir(outdir, { recursive: true });
  await writeConfig({ name: "acme-web", env: { prod: { name: "acme-prod-web", vars: { A: "1" } } } });
  await writeFile(join(outdir, "index.js"), "export default {};\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(config: Record<string, unknown>, at = worker): Promise<void> {
  await writeFile(join(at, "wrangler.jsonc"), `// the Worker\n${JSON.stringify(config)}`);
}

function stamp(options: { args?: readonly string[]; normalize?: (text: string) => string } = {}) {
  return appBundleStamp({ workerDir: worker, args: options.args ?? ARGS, processEnv: {}, outdir, ...options });
}

describe("appBundleStamp", () => {
  test("the same bundle and configuration give the same stamp", async () => {
    const first = await stamp();
    expect(first.stamp).toMatch(/^[0-9a-f]{32}$/);
    expect((await stamp()).stamp).toBe(first.stamp);
  });

  test("names the script the selected stanza deploys as", async () => {
    expect((await stamp()).scriptName).toBe("acme-prod-web");
    await writeConfig({ name: "acme-web", env: { staging: {} } });
    expect((await stamp({ args: ["deploy", "--env", "staging"] })).scriptName).toBe("acme-web-staging");
    expect((await stamp({ args: ["deploy"] })).scriptName).toBe("acme-web");
  });

  test("a change to the bundle changes the stamp", async () => {
    const before = await stamp();
    await writeFile(join(outdir, "index.js"), "export default { fetch() {} };\n");
    expect((await stamp()).stamp).not.toBe(before.stamp);
  });

  test("a module beside the entry is part of the bundle", async () => {
    const before = await stamp();
    await writeFile(join(outdir, "module.wasm"), Buffer.from([0, 97, 115, 109]));
    expect((await stamp()).stamp).not.toBe(before.stamp);
  });

  test("a change to the configuration changes the stamp, and a comment does not", async () => {
    const before = await stamp();
    await writeFile(
      join(worker, "wrangler.jsonc"),
      `// reworded\n${JSON.stringify({ name: "acme-web", env: { prod: { name: "acme-prod-web", vars: { A: "1" } } } })}`,
    );
    expect((await stamp()).stamp).toBe(before.stamp);
    await writeConfig({ name: "acme-web", env: { prod: { name: "acme-prod-web", vars: { A: "2" } } } });
    expect((await stamp()).stamp).not.toBe(before.stamp);
  });

  test("a change to the argv changes the stamp: a --var is configuration too", async () => {
    const before = await stamp();
    expect((await stamp({ args: [...ARGS, "--var", "PITHY_PRIVACY:{}"] })).stamp).not.toBe(before.stamp);
  });

  test("the privacy attestation is configuration, and the time it was attested is not", async () => {
    const attested = (attestedAt: string, consoleGate: "not_required" | "enforced" = "not_required") =>
      privacyVarArgs({ classes: [], consoleGate, reason: null, attestedAt } as Parameters<typeof privacyVarArgs>[0]);
    const before = await stamp({ args: [...ARGS, ...attested("2026-10-20T12:00:00.000Z")] });
    expect((await stamp({ args: [...ARGS, ...attested("2026-10-21T08:30:00.000Z")] })).stamp).toBe(before.stamp);
    expect((await stamp({ args: [...ARGS, ...attested("2026-10-20T12:00:00.000Z", "enforced")] })).stamp).not.toBe(
      before.stamp,
    );
  });

  test("wrangler's README and source maps are not part of it: both carry the time or the output path", async () => {
    const before = await stamp();
    await writeFile(join(outdir, "README.md"), `generated at ${Date.now()}`);
    await writeFile(join(outdir, "index.js.map"), `{"sourceRoot":"${outdir}"}`);
    expect((await stamp()).stamp).toBe(before.stamp);
  });

  test("the assets the configuration names are part of it", async () => {
    await writeConfig({ name: "acme-web", assets: { directory: "./dist/client" }, env: { prod: {} } });
    await mkdir(join(worker, "dist", "client"), { recursive: true });
    await writeFile(join(worker, "dist", "client", "index.html"), "<p>one</p>");
    const before = await stamp();
    await writeFile(join(worker, "dist", "client", "index.html"), "<p>two</p>");
    expect((await stamp()).stamp).not.toBe(before.stamp);
  });

  test("an asset that is a link is hashed as the file it leads to, as wrangler uploads it", async () => {
    await writeConfig({ name: "acme-web", assets: { directory: "./dist/client" }, env: { prod: {} } });
    const client = join(worker, "dist", "client");
    await mkdir(client, { recursive: true });
    await writeFile(join(root, "shared-headers"), "/*\n  X-Frame-Options: DENY\n");
    await symlink(join(root, "shared-headers"), join(client, "_headers"));
    const before = await stamp();
    await writeFile(join(root, "shared-headers"), "/*\n  X-Frame-Options: SAMEORIGIN\n");
    expect((await stamp()).stamp).not.toBe(before.stamp);
  });

  test("reads the build's redirected configuration, as wrangler does", async () => {
    await mkdir(join(worker, "dist", "worker"), { recursive: true });
    await mkdir(join(worker, ".wrangler", "deploy"), { recursive: true });
    await writeFile(join(worker, "dist", "worker", "wrangler.json"), JSON.stringify({ name: "acme-prod-web" }));
    await writeFile(
      join(worker, ".wrangler", "deploy", "config.json"),
      JSON.stringify({ configPath: "../../dist/worker/wrangler.json" }),
    );
    const before = await stamp();
    expect(before.scriptName).toBe("acme-prod-web");
    await writeFile(join(worker, "dist", "worker", "wrangler.json"), JSON.stringify({ name: "acme-prod-web", x: 1 }));
    expect((await stamp()).stamp).not.toBe(before.stamp);
  });

  test("the stamp var is never an input to its own hash", async () => {
    const before = await stamp();
    expect((await stamp({ args: [...ARGS, ...stampArgs(before.stamp)] })).stamp).toBe(before.stamp);
  });
});

describe("the argv halves", () => {
  test("bundleArgs bundles into a directory and uploads nothing", () => {
    expect(bundleArgs("/tmp/out")).toEqual(["--dry-run", "--outdir", "/tmp/out"]);
  });

  test("stampArgs carries the stamp as a plain-text var", () => {
    expect(stampArgs("abc")).toEqual(["--var", `${DEPLOY_STAMP_VAR}:abc`]);
  });
});

/**
 * A dry run bundles in a copy of the project whose `node_modules` is a link back to the project's. esbuild
 * follows the link, so a dependency's path comment reads `../../../<project>/node_modules/dep` from the copy and
 * `../../node_modules/dep` from the project. The stamp the dry run reports must be the one the deploy computes.
 */
describe("shadowBundlePaths", () => {
  test("puts a copy's path to the project back the way the project would write it", async () => {
    const project = join(root, "project");
    const copy = join(root, "copy");
    await mkdir(join(project, "apps", "web"), { recursive: true });
    await mkdir(join(copy, "apps", "web"), { recursive: true });
    const toProject = (text: string) => text.split(copy).join(project);
    const normalize = await shadowBundlePaths({ root: copy, toProject }, project, join(copy, "apps", "web"));
    expect(normalize("// ../../../project/node_modules/dep/index.js\n")).toBe("// ../../node_modules/dep/index.js\n");
    expect(normalize(`--config ${copy}/apps/web/.wrangler/pithy/x.json`)).toBe(
      `--config ${project}/apps/web/.wrangler/pithy/x.json`,
    );
    expect(normalize("// src/index.ts\n")).toBe("// src/index.ts\n");
  });

  test("the copy's bundle and the project's give one stamp", async () => {
    const project = join(root, "project");
    const copy = join(root, "copy");
    for (const base of [project, copy]) {
      await mkdir(join(base, "apps", "web"), { recursive: true });
      await writeConfig({ name: "acme-web", env: { prod: {} } }, join(base, "apps", "web"));
      await mkdir(join(base, "out"), { recursive: true });
    }
    await writeFile(join(project, "out", "index.js"), "// ../../node_modules/dep/index.js\nvar x = 1;\n");
    await writeFile(join(copy, "out", "index.js"), "// ../../../project/node_modules/dep/index.js\nvar x = 1;\n");
    const toProject = (text: string) => text.split(copy).join(project);
    const real = await appBundleStamp({
      workerDir: join(project, "apps", "web"),
      args: ARGS,
      processEnv: {},
      outdir: join(project, "out"),
    });
    const planned = await appBundleStamp({
      workerDir: join(copy, "apps", "web"),
      args: ARGS,
      processEnv: {},
      outdir: join(copy, "out"),
      normalize: await shadowBundlePaths({ root: copy, toProject }, project, join(copy, "apps", "web")),
    });
    expect(planned.stamp).toBe(real.stamp);
  });
});
