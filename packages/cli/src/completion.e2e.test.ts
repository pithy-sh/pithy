// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildDocsCatalog } from "./docs/catalog";

/**
 * **`pithy __complete` and `pithy completion`, on the real bin (#765).**
 *
 * The walk is `completion/complete.test.ts`'s; this is what the shell meets: a hidden command answered
 * before anything else in `bin.ts`, with no credentials, offline, writing nothing — and a bash script,
 * printed by the bin, that completes through the bin when it is `pithy` on the PATH.
 */

const run = promisify(execFile);

/** Print what bash's completion function left in COMPREPLY, one candidate a line. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a bash expansion is the probe, not a template.
const PRINT_REPLY = 'printf "%s\\n" "${COMPREPLY[@]}"';
const bin = join(import.meta.dirname, "bin.ts");

/**
 * Loaded ahead of the bin: every way out to a network is replaced by one that records the attempt and
 * throws. A Tab that reached for Cloudflare — a session renewal, an update check — would leave a mark here.
 */
const NO_NETWORK = `
import { appendFileSync } from "node:fs";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
const mark = (what) => () => {
  appendFileSync(process.env.NETWORK_MARK, what + "\\n");
  throw new Error("no network for a Tab: " + what);
};
globalThis.fetch = mark("fetch");
net.connect = mark("net.connect");
net.createConnection = mark("net.createConnection");
http.request = mark("http.request");
https.request = mark("https.request");
dns.lookup = mark("dns.lookup");
`;

let dir: string;
let home: string;
let config: string;
let mark: string;
let preload: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-completion-e2e-"));
  home = join(dir, "home");
  config = join(dir, "config");
  mark = join(dir, "network");
  preload = join(dir, "no-network.mjs");
  await mkdir(home);
  await mkdir(config);
  await writeFile(preload, NO_NETWORK);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A child environment with no account anywhere: no token, no account id, an empty config directory. */
function bareEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLOUDFLARE_") || key.startsWith("PITHY_")) delete env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    PITHY_CONFIG_DIR: config,
    PITHY_OFFLINE: "1",
    NETWORK_MARK: mark,
    // Bun's own transpiler cache would otherwise land in the home directory; it is the runtime's, not
    // Pithy's, and an installed `pithy` runs on node and writes none.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    ...extra,
  };
}

/** Ask the bin what a Tab at the end of `line` offers, from `cwd`. */
async function tab(line: string, cwd = dir): Promise<{ stdout: string; stderr: string }> {
  return run("bun", ["--preload", preload, bin, "__complete", line], { cwd, env: bareEnv() });
}

describe("pithy __complete", () => {
  test("answers with no credentials and offline, reaching for no network and writing nothing", async () => {
    const { stdout, stderr } = await tab("pithy secrets ");
    expect(stderr).toBe("");
    expect(stdout.split("\n").map((line) => line.split("\t")[0])).toEqual(
      expect.arrayContaining(["create", "rotate", "ls", "verify"]),
    );
    await expect(readdir(dir).then((names) => names.includes("network"))).resolves.toBe(false);
    expect(await readdir(config)).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });

  test("half-typed flags are not mistakes: no refusal, just the flags", async () => {
    const { stdout, stderr } = await tab("pithy dev --a");
    expect(stderr).toBe("");
    expect(stdout).toContain("--app");
  });

  test("--env completes the environments, and a word the tree lacks completes nothing, exit 0", async () => {
    expect((await tab("pithy migrate --env ")).stdout).toBe("dev\nstaging\nprod\n");
    expect(await tab("pithy nonsense --")).toEqual({ stdout: "", stderr: "" });
  });

  test("outside a Pithy project, --worker completes nothing and nothing errors", async () => {
    expect(await tab("pithy migrate --worker ")).toEqual({ stdout: "", stderr: "" });
  });

  test("inside one, --worker completes its Workers", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "wrangler.jsonc"), "{}");
    expect((await tab("pithy migrate --worker ")).stdout).toBe("api\n");
  });
});

describe("__complete is hidden", () => {
  test("from pithy --help", async () => {
    const { stdout } = await run("bun", [bin, "--help"], { env: bareEnv() });
    expect(stdout).toContain("completion");
    expect(stdout).not.toContain("__complete");
  });

  test("from pithy schema and the docs catalog", async () => {
    const { stdout } = await run("bun", [bin, "schema", "--json"], { env: bareEnv() });
    expect(stdout).not.toContain("__complete");
    const catalog = await buildDocsCatalog();
    expect(catalog.commands.map((command) => command.path)).toContain("completion");
    expect(JSON.stringify(catalog)).not.toContain("__complete");
  });
});

describe("pithy completion bash, loaded in bash", () => {
  /** A `pithy` on a PATH of its own that runs this checkout's bin, the way an installed one would. */
  async function onPath(): Promise<string> {
    const binDir = join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    const shim = join(binDir, "pithy");
    await writeFile(shim, `#!/bin/sh\nexec bun --preload "${preload}" "${bin}" "$@"\n`);
    await chmod(shim, 0o755);
    return binDir;
  }

  /** Load the script the bin prints, set bash's completion variables for `line`, and print COMPREPLY. */
  async function complete(line: string, words: string[]): Promise<string[]> {
    const binDir = await onPath();
    const probe = [
      'eval "$(pithy completion bash)"',
      `COMP_LINE=${JSON.stringify(line)}; COMP_POINT=${line.length}`,
      `COMP_WORDS=(${words.map((word) => JSON.stringify(word)).join(" ")}); COMP_CWORD=${words.length - 1}`,
      "_pithy_complete",
      PRINT_REPLY,
    ].join("\n");
    // `--norc`: bash reads a socket on stdin as a remote shell and would source `~/.bashrc`, whose PATH can put
    // an installed `pithy` ahead of this one (`completion/scripts.test.ts`).
    const { stdout } = await run("bash", ["--norc", "-c", probe], {
      cwd: dir,
      env: bareEnv({ PATH: `${binDir}:${process.env.PATH ?? ""}` }),
    });
    return stdout.split("\n").filter((value) => value !== "");
  }

  test("pithy <Tab> offers every top-level command", async () => {
    const offered = await complete("pithy ", ["pithy", ""]);
    expect(offered).toEqual(expect.arrayContaining(["init", "secrets", "dev", "deploy", "completion", "alias"]));
    expect(offered).not.toContain("__complete");
  });

  test("pithy secrets <Tab> offers the secrets subcommands", async () => {
    expect(await complete("pithy secrets ", ["pithy", "secrets", ""])).toEqual(
      expect.arrayContaining(["create", "rotate", "verify"]),
    );
  });

  test("pithy dev --<Tab> offers dev's flags and the ones every command takes", async () => {
    expect(await complete("pithy dev --", ["pithy", "dev", "--"])).toEqual(
      expect.arrayContaining(["--app", "--list", "--help", "--no-input"]),
    );
  });

  test("--env <Tab> offers the environments", async () => {
    expect(await complete("pithy migrate --env ", ["pithy", "migrate", "--env", ""])).toEqual([
      "dev",
      "staging",
      "prod",
    ]);
  });

  test("with the p. alias, p. <Tab> completes as pithy <Tab> does", async () => {
    expect(await complete("p. secrets ", ["p.", "secrets", ""])).toEqual(
      await complete("pithy secrets ", ["pithy", "secrets", ""]),
    );
  });

  test("no network was reached by any of it", async () => {
    await complete("pithy add ", ["pithy", "add", ""]);
    expect((await readdir(dir)).includes("network")).toBe(false);
  });
});
