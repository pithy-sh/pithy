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
import { type AdoptEntry, type AdoptResult, renderAdoptText, runAdopt } from "./adopt";

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

/** The project's registry, as a `devSecretsTargets` seam: one Worker, three declared secrets. */
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

  test("a json secret is parsed into the envelope the file states, and a broken one is refused by name", async () => {
    await devVars({ SECRETS_ENCRYPTION_KEYS: `{"currentVersion":"1","versions":{"1":"k"}}` });
    await adopt({ apply: true });
    const secrets = await readFile(join(config, "replay", "secrets.jsonc"), "utf8");
    expect(JSON.parse(secrets.replace(/^\/\/.*$/gm, ""))).toMatchObject({
      SECRETS_ENCRYPTION_KEYS: { versions: { "1": { currentVersion: "1", versions: { "1": "k" } } } },
    });

    await devVars({ SECRETS_ENCRYPTION_KEYS: "not-json-at-all" });
    await rm(join(config, "replay", "secrets.jsonc"));
    const broken = await adopt({ apply: true });
    expect(entry(broken, "SECRETS_ENCRYPTION_KEYS")).toMatchObject({ action: "refused", safeToRemove: false });
    await expect(stat(join(config, "replay", "secrets.jsonc"))).rejects.toThrow();
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
