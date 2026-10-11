// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EXIT, exitCodeOf, fixOf } from "../terminal/exitClass";
import { capabilityNotComposed, withAddFix } from "./notComposed";

/**
 * **A capability nobody composed exits 3, with a `pithy add` that runs as written as its `fix` (#697).** The
 * call was right; the project is missing what it depends on. `docs/CLI.md` §3.8.
 *
 * Runnable as written means with nobody to ask: `--worker` by apps/ directory when there are several Workers,
 * `--with-prerequisites` when the manifest declares peers, and no `fix` at all where a required option has no
 * value the kit may pick. `commands/addFix.test.ts` runs every one of them.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-not-composed-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A Worker in `apps/<name>/`, deployed as `demo-<name>`, so a directory and a script name differ. */
async function worker(name: string, config = true): Promise<string> {
  const at = join(dir, "apps", name);
  await mkdir(at, { recursive: true });
  await writeFile(join(at, "wrangler.jsonc"), JSON.stringify({ name: `demo-${name}` }));
  if (config) await writeFile(join(at, "pithy.config.ts"), "export default {};\n");
  return at;
}

/** An installed manifest for `name`. */
async function manifest(name: string, fields: Record<string, unknown> = {}): Promise<void> {
  const at = join(dir, "node_modules", "@pithy-sh", name);
  await mkdir(at, { recursive: true });
  await writeFile(
    join(at, "pithy.manifest.json"),
    JSON.stringify({ name, package: `@pithy-sh/${name}`, requiredBindings: [], ...fields }),
  );
}

describe("capabilityNotComposed", () => {
  const refusal = { message: "The audit capability is not configured.", action: "Run pithy add audit." };

  test("is a precondition, in the words it was handed, with pithy add as its fix", async () => {
    await worker("api");
    await manifest("audit");
    const error = await capabilityNotComposed("audit", refusal, { projectDir: dir });
    expect(error.payload).toMatchObject({ code: "core/precondition_failed", ...refusal });
    expect(exitCodeOf(error.payload)).toBe(EXIT.precondition);
    expect(fixOf(error)).toBe("pithy add audit");
  });

  test("carries the cause it was handed", async () => {
    const cause = new Error("underneath");
    expect((await capabilityNotComposed("audit", refusal, { projectDir: dir }, cause)).cause).toBe(cause);
  });

  test("no fix still exits 3", async () => {
    await worker("api");
    await worker("admin");
    const error = await capabilityNotComposed("audit", refusal, { projectDir: dir });
    expect(exitCodeOf(error.payload)).toBe(EXIT.precondition);
    expect(fixOf(error)).toBeUndefined();
  });
});

/** The `fix` {@link withAddFix} attaches to a refusal, or `undefined` when it attaches none. */
async function addFix(capability: string, scope: Parameters<typeof withAddFix>[2]): Promise<string | undefined> {
  return fixOf(await withAddFix(new PreconditionFailedError(), capability, scope));
}

describe("withAddFix", () => {
  test("names the Worker the refusal is about by its apps/ directory, never its script name", async () => {
    const api = await worker("api");
    await manifest("vector");
    expect(await addFix("vector", { projectDir: dir, workerDir: api })).toBe("pithy add vector --worker api");
  });

  test("several Workers and a refusal about the project: no Worker can be named, so no fix", async () => {
    await worker("api");
    await worker("admin");
    await manifest("audit");
    expect(await addFix("audit", { projectDir: dir })).toBeUndefined();
    expect(await addFix("audit", { projectDir: dir, workerDirs: ["/p/apps/api", "/p/apps/admin"] })).toBeUndefined();
  });

  test("a dev-only process is no Worker to choose between", async () => {
    await worker("api");
    await worker("web", false);
    await mkdir(join(dir, "apps", "web"), { recursive: true });
    await manifest("audit");
    expect(await addFix("audit", { projectDir: dir })).toBe("pithy add audit");
  });

  test("a manifest declaring peers adds --with-prerequisites", async () => {
    await worker("api");
    await manifest("email", { peerCapabilities: ["secrets"] });
    expect(await addFix("email", { projectDir: dir })).toBe("pithy add email --with-prerequisites");
  });

  test("a manifest that is not installed cannot rule prerequisites out", async () => {
    await worker("api");
    expect(await addFix("turnstile", { projectDir: dir })).toBe("pithy add turnstile --with-prerequisites");
  });

  test("a required option has no value the kit may pick, so no fix", async () => {
    await worker("api");
    await manifest("payments", {
      peerCapabilities: ["secrets"],
      configOptions: [{ key: "billingSubject", describe: "Who holds an entitlement." }],
    });
    expect(await addFix("payments", { projectDir: dir })).toBeUndefined();
  });
});
