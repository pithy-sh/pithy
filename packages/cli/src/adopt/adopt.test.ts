// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { DevSecretsTarget } from "../devSecrets/targets";
import type { StatePathOptions } from "../notifier/state";
import {
  type AdoptEntry,
  type AdoptResult,
  adoptRefusals,
  adoptSafeToRemove,
  renderAdoptText,
  runAdopt,
} from "./adopt";

/**
 * `pithy adopt` — the migration `pithy doctor` reports (#187).
 *
 * **Every test writes into a temp `PITHY_CONFIG_DIR`.** The real one holds this machine's live Cloudflare
 * API token and every project's dev secrets, and this is the one command in the CLI whose entire job is
 * moving credentials between files. A suite that resolved the real directory would either leak a token
 * into an assertion or write one project's secrets into another's file.
 *
 * **The project's name is `replay` and its Worker is `board`.** Deliberately different from each other and
 * from the checkout's basename: a fixture where the two agree cannot tell a per-project path from a
 * per-Worker one, and every destination here is keyed on the project.
 */

let dir: string;
let config: string;

function paths(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
}

/** The project's registry, as a `resolveDevSecretsTargets` seam: one Worker, three declared secrets. */
function targets(): DevSecretsTarget[] {
  const registry: SecretRegistry = {
    "auth-session-secret": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
    SECRETS_ENCRYPTION_KEYS: {
      backend: "cf-secrets-store",
      scope: "environment",
      rotatable: false,
      bootstrap: true,
      valueType: "json",
      schema: z.object({ currentVersion: z.string(), versions: z.record(z.string(), z.string()) }),
    },
  };
  return [{ name: "board", dir: join(dir, "apps", "board"), registry }];
}

/**
 * The scaffolding every test starts from: a root config naming `replay`, and one Worker directory.
 *
 * The Worker declares `TURNSTILE_SITEKEY` in its `wrangler.jsonc` `vars`, which is what makes that name a
 * `binding` rather than a key nothing reads — the distinction between `dev.json` and "delete it".
 */
async function project(): Promise<void> {
  await mkdir(join(dir, "apps", "board"), { recursive: true });
  await writeFile(join(dir, "pithy.config.ts"), `export default { name: "replay" };\n`);
  await writeFile(
    join(dir, "apps", "board", "wrangler.jsonc"),
    `{ "name": "replay-board", "vars": { "TURNSTILE_SITEKEY": "" } }\n`,
  );
}

/** The Worker set the classification is decided against, supplied rather than discovered on disk. */
function workers(): { name: string; dir: string; capabilities: [] }[] {
  return [{ name: "board", dir: join(dir, "apps", "board"), capabilities: [] }];
}

/** The old layout's root `.dev.vars` — the file this command reads and never writes. */
async function devVars(lines: Record<string, string>): Promise<void> {
  const body = Object.entries(lines)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await writeFile(join(dir, ".dev.vars"), `${body}\n`, { mode: 0o600 });
}

/** Run against the fixture, with the registry supplied rather than imported from a real composition. */
function adopt(options: { apply?: boolean; onPlan?: (entries: AdoptEntry[]) => void } = {}): Promise<AdoptResult> {
  return runAdopt({ projectDir: dir, paths: paths(), targets: targets(), workers: workers(), ...options });
}

/** One entry by key, so an assertion names what it is about rather than an array index. */
function entry(result: AdoptResult, key: string): AdoptEntry {
  const found = result.entries.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no plan entry for ${key} — the plan has ${result.entries.length}`);
  return found;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-adopt-project-"));
  config = await mkdtemp(join(tmpdir(), "pithy-adopt-config-"));
  await project();
});

afterEach(async () => {
  await chmod(join(config, "replay"), 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

describe("runAdopt", () => {
  test("sorts every key in the root .dev.vars to the file the current layout keeps it in", async () => {
    await devVars({
      CLOUDFLARE_ACCOUNT_ID: "acct-id",
      "auth-session-secret": "session-value",
      LEGACY_THING: "nothing-reads-this",
    });

    const result = await adopt({ apply: true });

    expect(entry(result, "CLOUDFLARE_ACCOUNT_ID")).toMatchObject({
      kind: "credential",
      action: "copy",
      destination: join(config, "cloudflare.json"),
    });
    expect(entry(result, "auth-session-secret")).toMatchObject({
      kind: "secret",
      action: "copy",
      destination: join(config, "replay", "secrets.jsonc"),
    });
    expect(entry(result, "LEGACY_THING")).toMatchObject({ kind: "unread", action: "leave", destination: null });

    const cloudflare = JSON.parse(await readFile(join(config, "cloudflare.json"), "utf8")) as Record<string, unknown>;
    expect(cloudflare.CLOUDFLARE_ACCOUNT_ID).toBe("acct-id");
    const secrets = await readFile(join(config, "replay", "secrets.jsonc"), "utf8");
    expect(JSON.parse(secrets.replace(/^\/\/.*$/gm, ""))).toMatchObject({
      "auth-session-secret": { currentVersion: "1", versions: { "1": "session-value" } },
    });
  });

  test("never deletes from the source, whatever it copied", async () => {
    await devVars({ CLOUDFLARE_API_TOKEN: "live-token", LEGACY_THING: "x" });
    await adopt({ apply: true });
    expect(await readFile(join(dir, ".dev.vars"), "utf8")).toContain("CLOUDFLARE_API_TOKEN=live-token");
    expect(await readFile(join(dir, ".dev.vars"), "utf8")).toContain("LEGACY_THING=x");
  });

  test("the default writes nothing at all", async () => {
    await devVars({ CLOUDFLARE_API_TOKEN: "live-token" });
    const result = await adopt();
    expect(result.applied).toBe(false);
    expect(entry(result, "CLOUDFLARE_API_TOKEN").action).toBe("copy");
    await expect(stat(join(config, "cloudflare.json"))).rejects.toThrow();
  });

  test("the plan is handed over before a byte is written", async () => {
    // The whole point of the callback: the command prints the plan, and the plan is true when it prints.
    await devVars({ CLOUDFLARE_API_TOKEN: "live-token" });
    let planned: AdoptEntry[] = [];
    let destinationExistedAtPlanTime = true;
    await adopt({
      apply: true,
      onPlan: (entries) => {
        planned = entries;
        destinationExistedAtPlanTime = existsSync(join(config, "cloudflare.json"));
      },
    });
    expect(planned.map((item) => item.action)).toEqual(["copy"]);
    expect(destinationExistedAtPlanTime).toBe(false);
    expect(existsSync(join(config, "cloudflare.json"))).toBe(true);
  });

  test("a second run copies nothing and says so", async () => {
    await devVars({ CLOUDFLARE_ACCOUNT_ID: "acct-id", "auth-session-secret": "session-value" });
    await adopt({ apply: true });

    const second = await adopt({ apply: true });
    expect(second.entries.map((item) => item.action)).toEqual(["present", "present"]);
    expect(renderAdoptText(second, "/home/nobody")).toContain("Nothing copied — everything is already there.");
  });

  test("a refusal is never reported as a clean pass", async () => {
    await devVars({ CLOUDFLARE_ACCOUNT_ID: "from-dev-vars" });
    await writeFile(join(config, "cloudflare.json"), JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "already-here" }), {
      mode: 0o600,
    });
    const text = renderAdoptText(await adopt({ apply: true }), "/home/nobody");
    expect(text).toContain("1 value refused above. Nothing was guessed.");
  });

  test("a value that differs from the one already at the destination is refused, not overwritten", async () => {
    await devVars({ CLOUDFLARE_ACCOUNT_ID: "from-dev-vars" });
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "cloudflare.json"), JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "already-here" }), {
      mode: 0o600,
    });

    const result = await adopt({ apply: true });

    expect(entry(result, "CLOUDFLARE_ACCOUNT_ID")).toMatchObject({ action: "conflict", safeToRemove: false });
    const after = JSON.parse(await readFile(join(config, "cloudflare.json"), "utf8")) as Record<string, unknown>;
    expect(after.CLOUDFLARE_ACCOUNT_ID).toBe("already-here");
  });

  test("a minted .dev.vars.<env> goes to tokens.json under its environment", async () => {
    await writeFile(join(dir, ".dev.vars.production"), "CF_TOKEN_CI_SYSTEM=prod-token\n", { mode: 0o600 });

    const result = await adopt({ apply: true });

    expect(entry(result, "CF_TOKEN_CI_SYSTEM")).toMatchObject({
      kind: "token",
      env: "production",
      action: "copy",
      destination: join(config, "replay", "tokens.json"),
    });
    const tokens = JSON.parse(await readFile(join(config, "replay", "tokens.json"), "utf8")) as Record<
      string,
      Record<string, string>
    >;
    expect(tokens.production?.CF_TOKEN_CI_SYSTEM).toBe("prod-token");
    // Named, never deleted — the value there may be the only copy of a live production credential.
    expect(await readFile(join(dir, ".dev.vars.production"), "utf8")).toContain("prod-token");
  });

  test("a registry secret copied into dev.json under vars moves to the secrets file", async () => {
    await mkdir(join(config, "replay"), { recursive: true });
    await writeFile(
      join(config, "replay", "dev.json"),
      JSON.stringify({ user: "jo@example.com", vars: { "auth-session-secret": "stale-copy" } }),
      { mode: 0o600 },
    );

    const result = await adopt({ apply: true });

    expect(entry(result, "auth-session-secret")).toMatchObject({
      kind: "secret",
      source: join(config, "replay", "dev.json"),
      action: "copy",
    });
    // The other tenant of dev.json is untouched, and so is the copy itself.
    const dev = JSON.parse(await readFile(join(config, "replay", "dev.json"), "utf8")) as Record<string, unknown>;
    expect(dev.user).toBe("jo@example.com");
    expect(dev.vars).toEqual({ "auth-session-secret": "stale-copy" });
  });

  test("a json secret is parsed into the payload the file states, and a broken one is refused by name", async () => {
    await devVars({ SECRETS_ENCRYPTION_KEYS: `{"currentVersion":"1","versions":{"1":"k"}}` });
    await adopt({ apply: true });
    const secrets = await readFile(join(config, "replay", "secrets.jsonc"), "utf8");
    // The `.dev.vars` line is what the binding carried, and the entry is that value — parsed out of its
    // serialized form and written as structure, with nothing wrapped around it (#323). Wrapping it here
    // would have made `pithy adopt` produce the shape this issue removed.
    expect(JSON.parse(secrets.replace(/^\/\/.*$/gm, ""))).toMatchObject({
      SECRETS_ENCRYPTION_KEYS: { currentVersion: "1", versions: { "1": "k" } },
    });

    await devVars({ SECRETS_ENCRYPTION_KEYS: "not-json-at-all" });
    await rm(join(config, "replay", "secrets.jsonc"));
    const broken = await adopt({ apply: true });
    expect(entry(broken, "SECRETS_ENCRYPTION_KEYS")).toMatchObject({ action: "refused", safeToRemove: false });
    await expect(stat(join(config, "replay", "secrets.jsonc"))).rejects.toThrow();
  });

  /**
   * The file states the payload, and a file written before it did states an envelope around it (#323).
   *
   * **An unmigrated file is the normal state of every project that has not run `pithy seed` since.** The
   * seeder reads both shapes; this command has to read both too, or it compares the old shape against the
   * `.dev.vars` line it was made from and answers `conflict` about a value that has not changed. Identical
   * values, opposite verdicts — and the verdict here is what an adopter deletes a line on the strength of.
   */
  test("a master key the file still wraps is present — the shape moved, the value did not", async () => {
    const payload = { currentVersion: "1", versions: { "1": "master-key" } };
    const wrapped = { SECRETS_ENCRYPTION_KEYS: { currentVersion: "1", versions: { "1": payload } } };
    await mkdir(join(config, "replay"), { recursive: true });
    await writeFile(join(config, "replay", "secrets.jsonc"), JSON.stringify(wrapped), { mode: 0o600 });
    await devVars({ SECRETS_ENCRYPTION_KEYS: JSON.stringify(payload) });

    const result = await adopt({ apply: true });

    expect(entry(result, "SECRETS_ENCRYPTION_KEYS")).toMatchObject({ action: "present", safeToRemove: true });
    // A `present` writes nothing, so the entry is still the one the file held. Restating it is `pithy
    // seed`'s job, and adopt does not have the second half of that (#323).
    const after = await readFile(join(config, "replay", "secrets.jsonc"), "utf8");
    expect(JSON.parse(after.replace(/^\/\/.*$/gm, ""))).toEqual(wrapped);
  });

  /**
   * An entry that is neither a valid declared payload nor a valid envelope: named, and left alone.
   *
   * The half of #323 this closes is the same line the first half took — a malformed secret is reported as
   * what it is, by name. Reading it as *nothing is there* is worse than a wrong message: `settle` then
   * plans a `copy`, and the copy overwrites the entry the adopter hand-wrote, in the one file that holds
   * their master key.
   */
  test("an entry that is neither payload nor envelope is refused by name, and stays exactly as written", async () => {
    await mkdir(join(config, "replay"), { recursive: true });
    const held = { "auth-session-secret": "bare-and-hand-written", SECRETS_ENCRYPTION_KEYS: 7 };
    await writeFile(join(config, "replay", "secrets.jsonc"), JSON.stringify(held), { mode: 0o600 });
    await devVars({ "auth-session-secret": "from-dev-vars", SECRETS_ENCRYPTION_KEYS: `{"currentVersion":"1"}` });

    const result = await adopt({ apply: true });

    const ordinary = entry(result, "auth-session-secret");
    expect(ordinary).toMatchObject({ action: "refused", safeToRemove: false });
    expect(ordinary.reason).toContain("auth-session-secret");
    expect(ordinary.reason).toContain("is not a versioned envelope");
    expect(entry(result, "SECRETS_ENCRYPTION_KEYS")).toMatchObject({ action: "refused", safeToRemove: false });

    const after = await readFile(join(config, "replay", "secrets.jsonc"), "utf8");
    expect(JSON.parse(after.replace(/^\/\/.*$/gm, ""))).toEqual(held);
  });

  /**
   * Reading the file through the registry re-serializes a `json` value in the schema's key order, and the
   * `.dev.vars` line it was copied from is in whatever order the adopter wrote it. Compared literally,
   * the second run conflicts with what the first run wrote — over a value nobody touched, which is the
   * failure this command exists to prevent, produced by the command itself.
   */
  test("a json secret's key order is not a difference, so the second run is not a conflict with the first", async () => {
    await devVars({ SECRETS_ENCRYPTION_KEYS: `{"versions":{"1":"k"},"currentVersion":"1"}` });
    await adopt({ apply: true });

    const second = await adopt({ apply: true });

    expect(entry(second, "SECRETS_ENCRYPTION_KEYS")).toMatchObject({ action: "present", safeToRemove: true });
  });

  test("a text secret whose value is JSON text stays text, so the next run is not a conflict with itself", async () => {
    // The plan compares what it will write; the write must write what the plan compared. Deriving the
    // envelope's value a second time — from a rule the writer applies and the planner did not — put an
    // object in the file for a `text` secret whose value happened to be `{"a":1}`, and the next run read
    // it back as a different value under the same name. That is the conflict this command exists to
    // prevent, produced by the command itself.
    await devVars({ "auth-session-secret": '{"a":1}' });
    await adopt({ apply: true });

    const secrets = await readFile(join(config, "replay", "secrets.jsonc"), "utf8");
    expect(JSON.parse(secrets.replace(/^\/\/.*$/gm, ""))).toMatchObject({
      "auth-session-secret": { versions: { "1": '{"a":1}' } },
    });
    expect((await adopt({ apply: true })).entries.map((item) => item.action)).toEqual(["present"]);
  });

  test("every destination lands 0600 inside a 0700 directory", async () => {
    await devVars({ CLOUDFLARE_ACCOUNT_ID: "acct", "auth-session-secret": "v", TURNSTILE_SITEKEY: "pk" });
    await adopt({ apply: true });

    for (const path of [
      join(config, "cloudflare.json"),
      join(config, "replay", "secrets.jsonc"),
      join(config, "replay", "dev.json"),
    ]) {
      expect(((await stat(path)).mode & 0o777).toString(8), path).toBe("600");
    }
    expect(((await stat(join(config, "replay"))).mode & 0o777).toString(8)).toBe("700");
  });

  test("no value reaches the result, the rendered report, or the JSON of either", async () => {
    await devVars({
      CLOUDFLARE_API_TOKEN: "cf-token-VALUE",
      "auth-session-secret": "session-VALUE",
      TURNSTILE_SITEKEY: "sitekey-VALUE",
      LEGACY_THING: "legacy-VALUE",
    });
    await writeFile(join(dir, ".dev.vars.production"), "CF_TOKEN_CI_SYSTEM=token-VALUE\n", { mode: 0o600 });

    const result = await adopt({ apply: true });
    const rendered = `${JSON.stringify(result)}\n${renderAdoptText(result, "/home/nobody")}`;
    for (const value of ["cf-token-VALUE", "session-VALUE", "sitekey-VALUE", "legacy-VALUE", "token-VALUE"]) {
      expect(rendered).not.toContain(value);
    }
  });

  test("a destination that is there and will not open refuses rather than being replaced", async () => {
    await devVars({ CLOUDFLARE_ACCOUNT_ID: "acct" });
    // A directory where the file goes: every uid gets EISDIR, unlike a chmod, which root ignores.
    await mkdir(join(config, "cloudflare.json"), { recursive: true });
    await expect(adopt({ apply: true })).rejects.toBeInstanceOf(PithyError);
  });
});

/**
 * A destination this plan could not be computed against (#222).
 *
 * The refusal existed and it arrived at the **write**, part-way through the entry loop, because `load`
 * read `tokens.json` and `dev.json` leniently and planned every value against what it got. So a broken
 * credential file was planned as *"the destination is empty"*, the adopter was shown that plan, some
 * entries copied, and then it stopped.
 *
 * For this command that is worse than a late failure. Its whole contract is *show the plan, copy, then
 * say what is safe to delete* — and a plan built against a file nothing could read may call a value safe
 * to remove when the destination does not hold what the plan claimed. It refuses per key on a conflict
 * precisely so the report can be trusted; reading leniently to build that report undercut it.
 *
 * So the planning read is the merge-base read, and a migration refuses where a migration should: before
 * it has told anybody anything.
 */
describe("a destination the plan could not be computed against (#222)", () => {
  /** Every source this fixture starts with, so a refusal can be held to changing none of them. */
  async function sources(): Promise<Record<string, string>> {
    await devVars({ CLOUDFLARE_ACCOUNT_ID: "acct-id", "auth-session-secret": "session-value" });
    await writeFile(join(dir, ".dev.vars.production"), "CF_TOKEN_CI_SYSTEM=prod-token\n", { mode: 0o600 });
    return {
      [join(dir, ".dev.vars")]: await readFile(join(dir, ".dev.vars"), "utf8"),
      [join(dir, ".dev.vars.production")]: await readFile(join(dir, ".dev.vars.production"), "utf8"),
    };
  }

  /** Run it, and answer whether the plan was ever handed over. A refusal that planned first is the bug. */
  async function refuses(): Promise<PithyError> {
    let planned = false;
    const thrown = (await adopt({
      apply: true,
      onPlan: () => {
        planned = true;
      },
    }).catch((error: unknown) => error)) as PithyError;
    expect(thrown, "the run did not refuse at all").toBeInstanceOf(PithyError);
    expect(planned, "the plan was handed over before the refusal — it was built against a file nothing read").toBe(
      false,
    );
    return thrown;
  }

  /** Nothing was written to any destination this run would have copied into. */
  async function copiedNothing(): Promise<void> {
    for (const path of [join(config, "cloudflare.json"), join(config, "replay", "secrets.jsonc")]) {
      await expect(stat(path), path).rejects.toThrow();
    }
  }

  test("a tokens.json that will not parse refuses before the plan, and copies nothing", async () => {
    // The likelier hand edit by far: a stray brace after someone opened a credential file to look at it.
    const held = `{ not json\n${JSON.stringify({ production: { CF_TOKEN_CI_SYSTEM: "live-token" } })}\n`;
    const before = await sources();
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(join(config, "replay", "tokens.json"), held, { mode: 0o600 });

    const thrown = await refuses();

    expect(thrown.payload.message).toContain(join(config, "replay", "tokens.json"));
    await copiedNothing();
    expect(await readFile(join(config, "replay", "tokens.json"), "utf8")).toBe(held);
    for (const [path, text] of Object.entries(before)) expect(await readFile(path, "utf8"), path).toBe(text);
  });

  test("a dev.json that is not the document Pithy keeps there refuses the same way", async () => {
    const held = `${JSON.stringify({ devLogin: { email: "me@example.com" }, vars: { K: 7 } }, null, 2)}\n`;
    const before = await sources();
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(join(config, "replay", "dev.json"), held, { mode: 0o600 });

    const thrown = await refuses();

    expect(thrown.payload.message).toContain(join(config, "replay", "dev.json"));
    await copiedNothing();
    expect(await readFile(join(config, "replay", "dev.json"), "utf8")).toBe(held);
    for (const [path, text] of Object.entries(before)) expect(await readFile(path, "utf8"), path).toBe(text);
  });

  test("a dry run refuses too — the plan it would print is the thing that is wrong", async () => {
    await sources();
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(join(config, "replay", "tokens.json"), "{ not json", { mode: 0o600 });
    await expect(adopt()).rejects.toBeInstanceOf(PithyError);
  });

  test("and the refusal names the file without quoting a byte of it", async () => {
    await sources();
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(config, "replay", "tokens.json"),
      `{ "production": { "CF_TOKEN_CI_SYSTEM": "live-token-VALUE" }`,
      { mode: 0o600 },
    );

    const thrown = await refuses();
    const payload = thrown.payload;

    // `message` may never quote the file — #219 drops `JSON.parse`'s own error for exactly this reason.
    expect(payload.message).toContain(join(config, "replay", "tokens.json"));
    expect(JSON.stringify(payload)).not.toContain("live-token-VALUE");
  });
});

describe("renderAdoptText", () => {
  test("the dry run names the flag that performs it, and says nothing was written", async () => {
    await devVars({ CLOUDFLARE_ACCOUNT_ID: "acct" });
    const text = renderAdoptText(await adopt(), "/home/nobody");
    expect(text).toContain("Nothing written");
    expect(text).toContain("pithy adopt --apply");
  });

  test("after a run it says what is now safe to remove, and never that a refused key is", async () => {
    await devVars({ CLOUDFLARE_ACCOUNT_ID: "acct", LEGACY_THING: "x" });
    await mkdir(config, { recursive: true });
    const text = renderAdoptText(await adopt({ apply: true }), "/home/nobody");
    expect(text).toContain("Nothing was deleted");
    expect(text).toContain("CLOUDFLARE_ACCOUNT_ID");
    // `unread` has no copy anywhere, so it is never called safe to remove — it gets doctor's sentence.
    expect(text).toContain("nothing reads");
  });
});

/**
 * A Worker whose `pithy.config.ts` will not import (#208).
 *
 * This is the caller where the conflation is worse than unhelpful. `adopt` decides where each value
 * belongs by asking the registry what the project declares, and an unresolvable config answered
 * "declares nothing" — so a registry secret read as a key nothing composes, and the report said so. It
 * deletes nothing itself, which is exactly why that matters: the loss arrives one step later, by hand,
 * on this command's advice.
 *
 * So it refuses to classify for a Worker it could not ask, names it, and moves everything it still has
 * positive evidence for. The shape already existed — it refuses per key on a conflict.
 */
describe("a Worker nobody could ask (#208)", () => {
  const broken = [
    {
      name: "replay-board",
      dir: join("apps", "board"),
      reason: "apps/board/pithy.config.ts would not import. Install dependencies, or fix the file.",
    },
  ];

  /** The state one broken config leaves: no registry, no Worker set, and one Worker named. */
  function unresolved(options: { apply?: boolean } = {}): Promise<AdoptResult> {
    return runAdopt({
      projectDir: dir,
      paths: paths(),
      targets: [],
      unresolvable: broken.map((entry) => ({ ...entry, dir: join(dir, entry.dir) })),
      workers: [],
      ...options,
    });
  }

  test("a value it could not classify is refused, not called safe to remove", async () => {
    await devVars({ "auth-session-secret": "session-value" });

    const result = await unresolved();
    const found = entry(result, "auth-session-secret");

    expect(found.kind).toBe("unclassified");
    expect(found.action).toBe("refused");
    expect(found.safeToRemove).toBe(false);
    expect(found.destination).toBeNull();
    expect(found.reason).toContain("replay-board");
  });

  test("it never reports the value as deletable — that verdict is what an adopter acts on", async () => {
    await devVars({ "auth-session-secret": "session-value" });

    const applied = await unresolved({ apply: true });

    expect(adoptSafeToRemove(applied)).toEqual([]);
    const text = renderAdoptText(applied, "/home/nobody");
    expect(text).not.toContain("nothing reads it");
    expect(text).not.toContain("delete these yourself");
    expect(text).toContain("replay-board");
  });

  test("a refusal fails the exit, so a script notices", async () => {
    await devVars({ "auth-session-secret": "session-value" });
    expect(adoptRefusals(await unresolved()).length).toBe(1);
  });

  test("the rest still moves — a Cloudflare credential needs no registry to place", async () => {
    await devVars({ CLOUDFLARE_ACCOUNT_ID: "acct-id", LEGACY_THING: "x" });

    const result = await unresolved({ apply: true });

    expect(entry(result, "CLOUDFLARE_ACCOUNT_ID").action).toBe("copy");
    expect(entry(result, "LEGACY_THING").action).toBe("refused");
    expect(JSON.parse(await readFile(join(config, "cloudflare.json"), "utf8"))).toMatchObject({
      CLOUDFLARE_ACCOUNT_ID: "acct-id",
    });
  });

  test("no value reaches the refusal, on this path either", async () => {
    await devVars({ "auth-session-secret": "session-value", LEGACY_THING: "nothing-reads-this" });

    const result = await unresolved();

    expect(JSON.stringify(result)).not.toContain("session-value");
    expect(renderAdoptText(result, "/home/nobody")).not.toContain("nothing-reads-this");
  });

  test("with every config readable, nothing changes", async () => {
    await devVars({ "auth-session-secret": "session-value", LEGACY_THING: "x" });

    const result = await adopt();

    expect(entry(result, "auth-session-secret").action).toBe("copy");
    expect(entry(result, "LEGACY_THING").action).toBe("leave");
  });
});

/**
 * The two-Worker case, against real configs on disk — because registries merge project-wide.
 *
 * Every test above supplies the resolution through a seam, which is right for the classification rules
 * and cannot catch the thing #199 and #208 are about: whether the *resolution itself* tells a config that
 * would not import apart from a Worker that declares nothing. One broken Worker beside a healthy one is
 * the case that catches a wrong claim — the healthy sibling's registry is real, and it is not the whole
 * project's answer.
 *
 * The scaffold lands **inside the package** for the reason every on-disk suite here does: the config's
 * `@pithy-sh/*` imports resolve against the workspace `node_modules`, and vitest only transforms a TS
 * config under the project root.
 */
describe("a broken config beside a healthy sibling, on disk (#208)", () => {
  let root: string;
  let configDir: string;

  /** What `pithy add secrets` writes, plus a capability that declares a secret of its own. */
  const COMPOSES_SECRETS = `
import { email } from "@pithy-sh/email/src/index";
import { secrets } from "@pithy-sh/secrets/src/index";

export default {
  capabilities: [
    secrets({ rotationIntervalDays: 30 }),
    email({ fromAddress: "noreply@example.com", fromName: "Replay", baseUrl: "https://board.example.com" }),
  ],
};
`;

  async function onDiskWorker(name: string, config: string): Promise<void> {
    const workerDir = join(root, "apps", name);
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: `replay-${name}` }));
    await writeFile(join(workerDir, "pithy.worker.jsonc"), JSON.stringify({ dev: { autostart: true } }));
    await writeFile(join(workerDir, "pithy.config.ts"), config);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(import.meta.dirname, "..", "..", ".e2e-adopt-"));
    configDir = await mkdtemp(join(tmpdir(), "pithy-adopt-e2e-config-"));
    await writeFile(join(root, "pithy.config.ts"), `export default { name: "replay" };\n`);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  test("the broken Worker is named, and its keys are refused rather than sorted", async () => {
    await onDiskWorker("board", "export default { capabilities: [] };\n{{{ not typescript =");
    await onDiskWorker("api", COMPOSES_SECRETS);
    await writeFile(
      join(root, ".dev.vars"),
      "email-link-signing-key=known\nMYSTERY_KEY=unknown\nCLOUDFLARE_ACCOUNT_ID=acct\n",
      { mode: 0o600 },
    );

    const result = await runAdopt({
      projectDir: root,
      paths: { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: configDir } },
    });

    // `api` resolved, so what it declares is still placed — a partial read is not no read.
    expect(entry(result, "email-link-signing-key").kind).toBe("secret");
    expect(entry(result, "CLOUDFLARE_ACCOUNT_ID").action).toBe("copy");
    // `board` did not, so nothing may claim it declares nothing.
    const mystery = entry(result, "MYSTERY_KEY");
    expect(mystery.kind).toBe("unclassified");
    expect(mystery.action).toBe("refused");
    expect(mystery.reason).toContain("replay-board");
    expect(adoptSafeToRemove(result)).toEqual([]);
  });

  test("with both configs readable, the same file sorts exactly as it always did", async () => {
    await onDiskWorker("board", COMPOSES_SECRETS);
    await onDiskWorker("api", COMPOSES_SECRETS);
    await writeFile(join(root, ".dev.vars"), "email-link-signing-key=known\nMYSTERY_KEY=unknown\n", { mode: 0o600 });

    const result = await runAdopt({
      projectDir: root,
      paths: { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: configDir } },
    });

    expect(entry(result, "email-link-signing-key").kind).toBe("secret");
    expect(entry(result, "MYSTERY_KEY").kind).toBe("unread");
  });
});
