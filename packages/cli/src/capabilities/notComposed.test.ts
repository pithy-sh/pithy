// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EXIT, exitCodeOf, fixOf } from "../terminal/exitClass";
import { capabilityNotComposed, secretsStoreIdMissing } from "./notComposed";

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
  const message = "The audit capability is not configured.";
  const refusal = { message, action: (add: string) => `Run ${add}.` };

  test("is a precondition, in the words it was handed, with pithy add as its fix", async () => {
    await worker("api");
    await manifest("audit");
    const error = await capabilityNotComposed("audit", refusal, { projectDir: dir });
    expect(error.payload).toMatchObject({
      code: "core/precondition_failed",
      message,
      action: "Run `pithy add audit --worker api`.",
    });
    expect(exitCodeOf(error.payload)).toBe(EXIT.precondition);
    // The Worker is named even where there is one: the command acts on one, and naming it costs nothing (#711).
    expect(fixOf(error)).toBe("pithy add audit --worker api");
  });

  // #711: the sentence and the `fix` are one command, from one builder, so they cannot disagree.
  test("the action names exactly the command the fix carries", async () => {
    const api = await worker("api");
    await worker("admin");
    await manifest("email", { peerCapabilities: ["secrets"] });
    const error = await capabilityNotComposed("email", refusal, { projectDir: dir, workerDir: api });
    expect(fixOf(error)).toBe("pithy add email --worker api --with-prerequisites");
    expect(error.payload.action).toBe(`Run \`${fixOf(error)}\`.`);
  });

  test("carries the cause it was handed", async () => {
    const cause = new Error("underneath");
    expect((await capabilityNotComposed("audit", refusal, { projectDir: dir }, cause)).cause).toBe(cause);
  });

  // No single Worker can be named, so no `fix`; the sentence names one command per Worker, each runnable as
  // written, rather than a `--worker <name>` placeholder every project refuses (#711).
  test("no fix still exits 3, and the action names a command for each Worker", async () => {
    await worker("api");
    await worker("admin");
    await manifest("audit");
    const error = await capabilityNotComposed("audit", refusal, { projectDir: dir });
    expect(exitCodeOf(error.payload)).toBe(EXIT.precondition);
    expect(fixOf(error)).toBeUndefined();
    expect(error.payload.action).toBe("Run `pithy add audit --worker admin` or `pithy add audit --worker api`.");
  });

  // An option with no default and no fixed values is only the adopter's to answer: the line says so, rather than
  // naming a command that is refused for the `--set` it lacks (#412, #711).
  test("a required option with no values to offer withholds the fix, and says what a person decides", async () => {
    await worker("api");
    await manifest("payments", {
      peerCapabilities: ["secrets"],
      configOptions: [{ key: "billingSubject", describe: "Who holds an entitlement." }],
    });
    const error = await capabilityNotComposed("payments", refusal, { projectDir: dir });
    expect(fixOf(error)).toBeUndefined();
    expect(error.payload.action).toBe(
      "payments needs billingSubject decided, and only you can. Pass each to pithy add with --set.",
    );
  });

  // A closed set is named whole, one command per value, and the kit picks none of them (#412, #711).
  test("a required option with fixed values names one command per value, and no fix", async () => {
    await worker("api");
    await manifest("payments", {
      peerCapabilities: ["secrets"],
      configOptions: [{ key: "billingSubject", describe: "Who holds it.", choices: ["user", "organization"] }],
    });
    const error = await capabilityNotComposed("payments", refusal, { projectDir: dir });
    expect(fixOf(error)).toBeUndefined();
    expect(error.payload.action).toBe(
      "Run `pithy add payments --worker api --with-prerequisites --set billingSubject=user` or `pithy add payments --worker api --with-prerequisites --set billingSubject=organization`.",
    );
  });
});

/** The `fix` {@link capabilityNotComposed} attaches to its refusal, or `undefined` when it attaches none. */
async function addFix(
  capability: string,
  scope: Parameters<typeof capabilityNotComposed>[2],
): Promise<string | undefined> {
  return fixOf(capabilityNotComposed(capability, { message: "m", action: (add) => add }, scope));
}

describe("the fix capabilityNotComposed attaches", () => {
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
    expect(await addFix("audit", { projectDir: dir })).toBe("pithy add audit --worker api");
  });

  test("a manifest declaring peers adds --with-prerequisites", async () => {
    await worker("api");
    await manifest("email", { peerCapabilities: ["secrets"] });
    expect(await addFix("email", { projectDir: dir })).toBe("pithy add email --worker api --with-prerequisites");
  });

  // The kit's own manifest answers while the package is absent (#711), so its peers are read, not guessed.
  test("a manifest that is not installed is read from the kit's", async () => {
    await worker("api");
    expect(await addFix("turnstile", { projectDir: dir })).toBe(
      "pithy add turnstile --worker api --with-prerequisites",
    );
    expect(await addFix("vector", { projectDir: dir })).toBe("pithy add vector --worker api");
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

/**
 * **The store-id refusal names the `pithy add secrets` that records it, runnable as written (#711).** It is the
 * refusal `email`, `media`, `payments`, `storage` and `secrets` provision share, so its sentence is pinned here
 * once: the Workers that compose secrets are named, every configured one only when none does, and `why` rides in
 * parentheses only when the caller gave one.
 */
describe("secretsStoreIdMissing", () => {
  test("a precondition: exit 3, with the store named", async () => {
    await worker("api");
    const error = secretsStoreIdMissing(dir);
    expect(error).toBeInstanceOf(PreconditionFailedError);
    expect(exitCodeOf(error.payload)).toBe(EXIT.precondition);
    expect(error.payload.message).toBe("The CF Secrets Store id is missing.");
  });

  test("one Worker, no why: its command and nothing after it, which is also the fix", async () => {
    await worker("api");
    const error = secretsStoreIdMissing(dir);
    expect(error.payload.action).toBe("Run `pithy add secrets --worker api` to record SECRETS_STORE_ID.");
    expect(fixOf(error)).toBe("pithy add secrets --worker api");
  });

  test("one Worker, with why: the reason in parentheses", async () => {
    await worker("api");
    expect(secretsStoreIdMissing(dir, "the media worker decrypts its credentials from it").payload.action).toBe(
      "Run `pithy add secrets --worker api` to record SECRETS_STORE_ID (the media worker decrypts its credentials from it).",
    );
  });

  // #711: offered for every configured Worker, the line composed secrets into a Worker that had nothing to do
  // with it. The Workers that compose secrets already are the ones named.
  test("names only the Workers composing secrets, when one does", async () => {
    await worker("web");
    const api = await worker("api");
    await writeFile(join(api, "pithy.config.ts"), "export default {\n  capabilities: [\n    secrets(),\n  ],\n};\n");
    const error = secretsStoreIdMissing(dir);
    expect(error.payload.action).toBe("Run `pithy add secrets --worker api` to record SECRETS_STORE_ID.");
    expect(fixOf(error)).toBe("pithy add secrets --worker api");
  });

  test("two Workers: one command each, because the bare one is refused input/required", async () => {
    await worker("web");
    await worker("api");
    expect(secretsStoreIdMissing(dir).payload.action).toBe(
      "Run `pithy add secrets --worker api` or `pithy add secrets --worker web` to record SECRETS_STORE_ID.",
    );
  });

  test("two Workers, with why", async () => {
    await worker("web");
    await worker("api");
    expect(secretsStoreIdMissing(dir, "the sweep worker decrypts its credentials from it").payload.action).toBe(
      "Run `pithy add secrets --worker api` or `pithy add secrets --worker web` to record SECRETS_STORE_ID (the sweep worker decrypts its credentials from it).",
    );
  });

  test("a dev-only process beside one Worker is not counted", async () => {
    await worker("api");
    await worker("site", false);
    expect(secretsStoreIdMissing(dir).payload.action).toBe(
      "Run `pithy add secrets --worker api` to record SECRETS_STORE_ID.",
    );
  });
});
