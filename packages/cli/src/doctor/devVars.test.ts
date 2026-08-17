// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUDFLARE_ENV_KEYS } from "@pithy-sh/cloudflare/src/env/devVars";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeBootstrapVars } from "../devSecrets/bootstrapVars";
import { GENERATED_HEADER } from "../devSecrets/generate";
import type { DevSecretsTarget } from "../devSecrets/targets";
import type { StatePathOptions } from "../notifier/state";
import {
  checkDevVars,
  type DevVarsCheck,
  describeDevVars,
  devVarsHealthy,
  isCloudflareEnvKey,
  ROOT_DEV_VAR_STATES,
  type RootDevVarState,
} from "./devVars";

const registry = defineSecretRegistry({
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
  CONNECTION_KEY_ENCRYPTION_KEY: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "text",
    devValue: "random",
  },
});

/** The secrets capability's own shape: a binding whose dev value never comes from a registry. */
const composes = (...names: string[]): Capability[] =>
  names.map((name) => ({ name, requiredBindings: [{ type: "secret", name }] }) as unknown as Capability);

let dir: string;
let config: string;

function paths(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-dev-vars-"));
  config = await mkdtemp(join(tmpdir(), "pithy-dev-vars-config-"));
  // Deliberately not the Worker's name. A fixture where the project and the Worker share one string
  // hides every defect that reads the wrong one of the two — see #136.
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

/** A Worker directory with a `wrangler.jsonc`, and whatever capabilities the test says it composes. */
async function worker(name: string, config: unknown, capabilities: Capability[] = []) {
  const path = join(dir, "apps", name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
  return { name, dir: path, capabilities };
}

/** A generated `.dev.vars`, as `renderDevVars` writes one: the header, a blank line, then the values. */
async function generated(workerDir: string, values: Record<string, string> = {}) {
  const lines = [...GENERATED_HEADER, "", ...Object.entries(values).map(([key, value]) => `${key}=${value}`)];
  await writeFile(join(workerDir, ".dev.vars"), `${lines.join("\n")}\n`);
}

function targets(dirs: { name: string; dir: string }[]): DevSecretsTarget[] {
  return dirs.map((entry) => ({ name: entry.name, dir: entry.dir, registry }));
}

function check(workers: { name: string; dir: string; capabilities: Capability[] }[]): Promise<DevVarsCheck> {
  return checkDevVars({ projectDir: dir, workers, targets: targets(workers), paths: paths() });
}

describe("the generated .dev.vars — is the Worker getting anything", () => {
  /**
   * #178, reproduced: the dashboard's `apps/board/.dev.vars` was a header and nothing else, and the
   * first thing that said so was a 500 from a running Worker naming the bindings it did not have.
   */
  test("a generated file with a header and no values names the Worker", async () => {
    const board = await worker("board", { vars: {} });
    await generated(board.dir);

    const result = await check([board]);

    expect(result.empty).toEqual([{ worker: "board", file: join("apps", "board", ".dev.vars") }]);
    expect(describeDevVars(result)[0]).toContain("board");
    expect(describeDevVars(result)[0]).toContain(join("apps", "board", ".dev.vars"));
    expect(devVarsHealthy(result)).toBe(false);
  });

  test("a generated file with values is silent — that is the working state", async () => {
    const board = await worker("board", { vars: {} });
    await generated(board.dir, { SECRETS_ENCRYPTION_KEYS: "{}" });
    expect((await check([board])).empty).toEqual([]);
  });

  test("no file at all is not a finding — nothing has generated one yet, and pithy dev will", async () => {
    const board = await worker("board", { vars: {} });
    expect((await check([board])).empty).toEqual([]);
  });

  test("a .dev.vars pithy did not write is the adopter's, and is not judged here", async () => {
    // `generateDevVars` refuses to touch one without the marker. Reading its contents to grade them
    // would be the same overreach one report further along.
    const board = await worker("board", { vars: {} });
    await writeFile(join(board.dir, ".dev.vars"), "# mine\n");
    expect((await check([board])).empty).toEqual([]);
  });

  test("each Worker is judged on its own file, and the empty one is named", async () => {
    const board = await worker("board", { vars: {} });
    const web = await worker("web", { vars: {} });
    await generated(board.dir);
    await generated(web.dir, { PUBLIC_URL: "http://localhost" });

    expect((await check([board, web])).empty.map((entry) => entry.worker)).toEqual(["board"]);
  });
});

describe("the root .dev.vars — is anything reading it", () => {
  test("a Cloudflare credential left in the checkout is named, and where it belongs now", async () => {
    // It used to be the one silent class here: the CLI read `CLOUDFLARE_ENV_KEYS` out of exactly this
    // file. They are account-scoped and live in `<config>/cloudflare.json` since #182, so this copy is a
    // live credential in a checkout that nothing reads.
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=abc\nCLOUDFLARE_API_TOKEN=tok\n");

    const result = await check([board]);

    expect(result.root.map((entry) => entry.state)).toEqual(["credential", "credential"]);
    const lines = describeDevVars(result).join("\n");
    expect(lines).toContain("CLOUDFLARE_API_TOKEN is in .dev.vars, which nothing reads now");
    expect(lines).toContain("cloudflare.json");
    // Never the value.
    expect(lines).not.toContain("tok");
    expect(devVarsHealthy(result)).toBe(false);
  });

  test("every key the CLI used to read out of that file is classified as a credential, so a fourth one cannot arrive unclassified", async () => {
    // The gate, stated as the invariant: `CLOUDFLARE_ENV_KEYS` is the whole list of what moved out of
    // the checkout. Add a key there and this passes; classify by anything else and it fails.
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), CLOUDFLARE_ENV_KEYS.map((key) => `${key}=x`).join("\n"));

    const result = await check([board]);

    expect(result.root.every((entry) => entry.state === "credential")).toBe(true);
    expect(describeDevVars(result)).toHaveLength(CLOUDFLARE_ENV_KEYS.length);
  });

  test("a .dev.vars.<env> the old token sink left behind is named, with its environment", async () => {
    // #182: `pithy token mint --env production --store dev-vars` wrote a live production Cloudflare
    // token here. Reported, never deleted — that value may be the only copy of it anywhere (#142).
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars.production"), "CF_TOKEN_CI_SYSTEM=live-production-token\n");
    await writeFile(join(dir, ".dev.vars.local"), "MINE=1\n");
    await writeFile(join(dir, ".dev.vars.example"), "CLOUDFLARE_API_TOKEN=\n");

    const result = await check([board]);

    // `.local` is the override file and `.example` is committed documentation. Neither is a minted one.
    expect(result.minted).toEqual([{ file: ".dev.vars.production", env: "production" }]);
    const lines = describeDevVars(result).join("\n");
    expect(lines).toContain(".dev.vars.production holds a credential minted for production");
    expect(lines).not.toContain("live-production-token");
    expect(devVarsHealthy(result)).toBe(false);
  });

  test("a registry secret still copied into dev.json is named, and nothing else there is", async () => {
    // #179: `pithy seed` used to copy every `cf-secrets-store` value into `dev.json` under `vars`, and
    // the generator read that copy. Nothing reads it now. A value no registry declares — a Turnstile
    // sitekey — is a legitimate tenant of that file and stays silent.
    const board = await worker("board", { vars: {} });
    await writeBootstrapVars(dir, { CONNECTION_KEY_ENCRYPTION_KEY: "stale", TURNSTILE_SITEKEY: "0x4AAA" }, paths());

    const result = await check([board]);

    expect(result.devJsonSecrets).toEqual(["CONNECTION_KEY_ENCRYPTION_KEY"]);
    const lines = describeDevVars(result).join("\n");
    expect(lines).toContain("CONNECTION_KEY_ENCRYPTION_KEY");
    expect(lines).toContain("pithy secrets edit");
    expect(lines).not.toContain("TURNSTILE_SITEKEY");
    expect(lines).not.toContain("stale");
  });

  test("a registry secret is left to checkDevSecrets, which says which file it belongs in", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=old\nCONNECTION_KEY_ENCRYPTION_KEY=k\n");

    const result = await check([board]);

    expect(result.root.map((entry) => entry.state)).toEqual(["secret", "secret"]);
    // One finding, one sentence. Two checks naming the same key twice is a report nobody finishes.
    expect(describeDevVars(result)).toEqual([]);
  });

  /**
   * The dashboard's `SECRETS_ENCRYPTION_KEYS`: a value that is real, that a Worker requires as a
   * binding, and that no Worker reads from this file. Classifying it as "nothing reads this" would
   * advise deleting the project's dev master key, so the composed set has to be known before the
   * "nothing reads this" case can be stated safely.
   */
  test("a binding the project composes is named as stranded, never as deletable", async () => {
    const board = await worker("board", { vars: {} }, composes("SECRETS_ENCRYPTION_KEYS"));
    await writeFile(join(dir, ".dev.vars"), "SECRETS_ENCRYPTION_KEYS={}\n");

    const result = await check([board]);

    expect(result.root).toEqual([{ key: "SECRETS_ENCRYPTION_KEYS", state: "binding", workers: ["board"] }]);
    const line = describeDevVars(result).join("\n");
    expect(line).toContain("SECRETS_ENCRYPTION_KEYS");
    expect(line).toContain("board");
    expect(line).toContain("no Worker reads");
    expect(line).not.toContain("Delete it");
  });

  test("a name declared in wrangler.jsonc vars counts as composed too — even in one environment only", async () => {
    const board = await worker("board", { vars: {}, env: { staging: { vars: { REGION: "weur" } } } });
    await writeFile(join(dir, ".dev.vars"), "REGION=local\n");
    expect((await check([board])).root.map((entry) => entry.state)).toEqual(["binding"]);
  });

  test("a key nothing declares is the nothing-reads-this case, and is told to go", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), "LEFTOVER_FROM_2024=x\n");

    const result = await check([board]);

    expect(result.root).toEqual([{ key: "LEFTOVER_FROM_2024", state: "unread", workers: [] }]);
    expect(describeDevVars(result).join("\n")).toContain("nothing reads it");
    expect(devVarsHealthy(result)).toBe(false);
  });

  test("no root file is no keys, and nothing to say", async () => {
    const board = await worker("board", { vars: {} });
    const result = await check([board]);
    expect(result.root).toEqual([]);
    expect(devVarsHealthy(result)).toBe(true);
  });

  /**
   * The invariant the whole module turns on: **every** key in that file is classified. The `d1`-only
   * check next door failed precisely by having a class of key that reached no branch, so a fixture
   * carrying one of each shape must come back with one verdict per key and no key unaccounted for.
   */
  test("every key in the file is classified exactly once — nothing falls through", async () => {
    const board = await worker("board", { vars: {} }, composes("SECRETS_ENCRYPTION_KEYS"));
    const keys = ["CLOUDFLARE_API_TOKEN", "auth-session-secret", "SECRETS_ENCRYPTION_KEYS", "LEFTOVER_FROM_2024"];
    await writeFile(join(dir, ".dev.vars"), keys.map((key) => `${key}=x`).join("\n"));

    const result = await check([board]);

    expect(result.root.map((entry) => entry.key).sort()).toEqual([...keys].sort());
    // Every state but `unclassified`, which needs a Worker nobody could ask — see the #208 block below.
    const classified = ROOT_DEV_VAR_STATES.filter((state) => state !== "unclassified");
    expect(new Set(result.root.map((entry) => entry.state))).toEqual(new Set(classified));
  });

  test("every state either prints a sentence or is another check's to print — none is merely forgotten", () => {
    // Add a state to `ROOT_DEV_VAR_STATES` and this fails until it is either given a sentence or
    // deliberately assigned to the check that owns it. The two silent ones are named, not defaulted.
    // One silent state, and it is named rather than defaulted: `secret` is `describeDevSecrets`'s to
    // report, which says which file the value belongs in and in what shape. `credential` stopped being
    // silent with #182 — the CLI does not read that file any more, so a live Cloudflare token sitting
    // in it is a value nothing reads and worth a sentence of its own.
    const silent: RootDevVarState[] = ["secret"];
    for (const state of ROOT_DEV_VAR_STATES) {
      const lines = describeDevVars({
        root: [{ key: "SOME_KEY", state, workers: ["board"] }],
        empty: [],
        minted: [],
        devJsonSecrets: [],
        devConfigPath: "/config/replay/dev.json",
        mintedTokensPath: "/config/replay/tokens.json",
        // Stated, because `unclassified` only exists when one is — and the sentence it earns names it.
        unresolvable: [{ name: "replay-board", dir: "/p/apps/board", reason: "pithy.config.ts would not import." }],
      });
      // The unresolvable Worker is itself a line, so every state here is judged on the lines *its own*
      // key adds rather than on the block being empty.
      const own = lines.filter((line) => line.startsWith("SOME_KEY"));
      expect(own.length === 0).toBe(silent.includes(state));
    }
  });

  test("no value ever reaches the report", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), "LEFTOVER=s3cr3t\n");

    const result = await check([board]);

    expect(JSON.stringify(result)).not.toContain("s3cr3t");
    expect(describeDevVars(result).join("\n")).not.toContain("s3cr3t");
  });

  test("names this machine's dev config, resolved from the project's name and not guessed", async () => {
    const board = await worker("board", { vars: {} }, composes("SECRETS_ENCRYPTION_KEYS"));
    await writeFile(join(dir, ".dev.vars"), "SECRETS_ENCRYPTION_KEYS={}\n");

    const result = await check([board]);

    expect(result.devConfigPath).toBe(join(config, "replay", "dev.json"));
    expect(describeDevVars(result).join("\n")).toContain(join(config, "replay", "dev.json"));
  });
});

describe("isCloudflareEnvKey", () => {
  test("is the readers' own list, not a backend proxy", () => {
    for (const key of CLOUDFLARE_ENV_KEYS) expect(isCloudflareEnvKey(key)).toBe(true);
    expect(isCloudflareEnvKey("CONNECTION_KEY_ENCRYPTION_KEY")).toBe(false);
    expect(isCloudflareEnvKey("auth-session-secret")).toBe(false);
  });
});

/**
 * A Worker whose `pithy.config.ts` will not import is not a Worker that declares nothing (#208).
 *
 * the lossy wrapper answered both states with `[]`, and this check read the second as the first: with
 * no registry, every key in the root `.dev.vars` classified as `unread` — "nothing reads it, delete it" —
 * including the registry secrets the broken Worker declares. Registries merge project-wide, so a healthy
 * sibling does not save it: the answer for the *project* is missing whatever the unreadable one held.
 *
 * `doctor` is run because something is already wrong, so the fix is never a refusal. It names the Worker,
 * withholds the one claim it cannot make, and prints the rest of the report.
 */
describe("a Worker nobody could ask (#208)", () => {
  const broken = [
    { name: "replay-board", dir: "/p/apps/board", reason: "apps/board/pithy.config.ts would not import. Fix it." },
  ];

  test("a key nothing appears to read is unclassified, never 'delete it'", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=x\n");

    const result = await checkDevVars({
      projectDir: dir,
      workers: [board],
      // The state a broken config leaves: no registry resolved, and a Worker that could not be asked.
      targets: [],
      unresolvable: broken,
      paths: paths(),
    });

    expect(result.root).toEqual([{ key: "auth-session-secret", state: "unclassified", workers: [] }]);
    expect(describeDevVars(result).join("\n")).not.toContain("Delete it");
  });

  test("the report names the Worker and why, and keeps everything else it had to say", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_API_TOKEN=tok\nSOMETHING_ELSE=x\n");

    const result = await checkDevVars({
      projectDir: dir,
      workers: [board],
      targets: [],
      unresolvable: broken,
      paths: paths(),
    });
    const lines = describeDevVars(result);

    expect(lines[0]).toContain("replay-board");
    expect(lines[0]).toContain("would not import");
    // The credential line is decided by `CLOUDFLARE_ENV_KEYS`, not by any registry, so it is still said.
    expect(lines.join("\n")).toContain("CLOUDFLARE_API_TOKEN is in .dev.vars");
    expect(lines.join("\n")).toContain("SOMETHING_ELSE");
    expect(devVarsHealthy(result)).toBe(false);
  });

  test("a healthy sibling's registry still classifies its own secrets — a partial read is not no read", async () => {
    const api = await worker("api", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=x\nSTRAY=y\n");

    const result = await checkDevVars({
      projectDir: dir,
      workers: [api],
      targets: targets([api]),
      unresolvable: broken,
      paths: paths(),
    });

    // Positive evidence survives a partial read: `api` declares this one, and that is a fact.
    expect(result.root.find((entry) => entry.key === "auth-session-secret")?.state).toBe("secret");
    // The negative claim does not: `board` may declare `STRAY`, and nobody can say it does not.
    expect(result.root.find((entry) => entry.key === "STRAY")?.state).toBe("unclassified");
  });

  test("nothing unresolvable is silence — the check carries it whether or not it prints", async () => {
    const board = await worker("board", { vars: {} });
    const result = await checkDevVars({ projectDir: dir, workers: [board], targets: targets([board]), paths: paths() });
    expect(result.unresolvable).toEqual([]);
  });
});
