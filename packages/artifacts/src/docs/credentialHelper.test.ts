// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * **The helper in `docs/credential-helper.md` is run, not read (#673).** The script is lifted out of the page and
 * handed to a real `git credential fill`, against a stand-in for the app's mint route. So what the page tells an
 * adopter to install is what this proves: a mint git can use, and a refused mint that says why and stops git there,
 * rather than `curl: (22) … 404` followed by a username prompt.
 */

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "../../docs/credential-helper.md");
const TOKEN = `art_v1_${"a".repeat(40)}?expires=1800000000`;
const REMOTE_PATH = "git/acme-prod/docs-1.git";

/** The one fenced block under `## The helper`. */
async function helperScript(): Promise<string> {
  const page = await readFile(PAGE, "utf8");
  const section = page.split(/^## The helper$/m)[1] ?? "";
  const script = /```sh\n([\s\S]*?)```/.exec(section)?.[1];
  if (!script) throw new Error("docs/credential-helper.md has no ```sh block under `## The helper`.");
  return script;
}

/** What the stand-in mint route answers next, and what it was asked. */
let answer: { status: number; body: unknown } = { status: 200, body: {} };
const asked: { path: string; authorization: string | undefined; apiKey?: string }[] = [];

function mint(req: IncomingMessage, res: ServerResponse): void {
  const apiKey = req.headers["x-api-key"];
  asked.push({
    path: req.url ?? "",
    authorization: req.headers.authorization,
    ...(typeof apiKey === "string" ? { apiKey } : {}),
  });
  res.writeHead(answer.status, { "content-type": "application/json" });
  res.end(JSON.stringify(answer.body));
}

let server: Server;
let origin: string;
let dir: string;
let helper: string;
/** Every argv the helper hands `curl`, one line per call, written by a shim ahead of the real one on `PATH`. */
let argvLog: string;
let shimDir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-credential-helper-"));
  helper = join(dir, "git-credential-pithy");
  await writeFile(helper, await helperScript());
  await chmod(helper, 0o755);
  shimDir = join(dir, "bin");
  argvLog = join(dir, "curl-argv.log");
  const realCurl = execFileSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).trim();
  await mkdir(shimDir);
  await writeFile(join(shimDir, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec '${realCurl}' "$@"\n`);
  await chmod(join(shimDir, "curl"), 0o755);
  server = createServer(mint);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

/**
 * `git credential fill` for one Artifacts remote, with only this helper configured: no system or global config, no
 * terminal prompt and no askpass, so a git that would have asked for a username fails saying so instead of hanging.
 */
function fill(
  appUrl: string,
  useHttpPath = true,
  credential: Record<string, string> = { PITHY_APP_TOKEN: "app-credential" },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-c", `credential.helper=${helper}`, "-c", `credential.useHttpPath=${useHttpPath}`, "credential", "fill"],
      {
        env: {
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          HOME: dir,
          XDG_CONFIG_HOME: dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          PITHY_APP_URL: appUrl,
          ...credential,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`protocol=https\nhost=acct.artifacts.cloudflare.net\npath=${REMOTE_PATH}\n\n`);
  });
}

describe("the credential helper in docs/credential-helper.md", () => {
  test("mints for the repository in the remote path and hands git the token as the Basic password", async () => {
    answer = {
      status: 200,
      body: { token: TOKEN, scope: "write", expiresAt: "2027-01-15T08:00:00.000Z", remote: "x" },
    };
    asked.length = 0;
    const run = await fill(origin);
    expect(run.code, run.stderr).toBe(0);
    expect(asked).toEqual([{ path: "/artifacts/repos/docs-1/credentials", authorization: "Bearer app-credential" }]);
    expect(run.stdout).toContain(`password=${TOKEN}\n`);
    expect(run.stdout).toContain("username=x\n");
    expect(run.stdout).toContain("password_expiry_utc=1800000000\n");
  });

  test("never puts the app's credential in curl's argv, where any local user can read it", async () => {
    answer = {
      status: 200,
      body: { token: TOKEN, scope: "write", expiresAt: "2027-01-15T08:00:00.000Z", remote: "x" },
    };
    asked.length = 0;
    await writeFile(argvLog, "");
    const run = await fill(origin);
    expect(run.code, run.stderr).toBe(0);
    expect(asked[0]?.authorization).toBe("Bearer app-credential");
    const argv = await readFile(argvLog, "utf8");
    expect(argv).toContain("/artifacts/repos/docs-1/credentials");
    expect(argv).not.toContain("app-credential");
  });

  test("sends an API key as x-api-key, where Better Auth's apiKey() plugin reads it, and never in curl's argv", async () => {
    answer = {
      status: 200,
      body: { token: TOKEN, scope: "write", expiresAt: "2027-01-15T08:00:00.000Z", remote: "x" },
    };
    asked.length = 0;
    await writeFile(argvLog, "");
    const run = await fill(origin, true, { PITHY_APP_KEY: "app-api-key" });
    expect(run.code, run.stderr).toBe(0);
    expect(asked).toEqual([
      { path: "/artifacts/repos/docs-1/credentials", authorization: undefined, apiKey: "app-api-key" },
    ]);
    expect(run.stdout).toContain(`password=${TOKEN}\n`);
    expect(await readFile(argvLog, "utf8")).not.toContain("app-api-key");
  });

  test("refuses both a token and a key, or neither, and mints nothing", async () => {
    asked.length = 0;
    const credentials: Record<string, string>[] = [{ PITHY_APP_TOKEN: "t", PITHY_APP_KEY: "k" }, {}];
    for (const credential of credentials) {
      const run = await fill(origin, true, credential);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("PITHY_APP_TOKEN or PITHY_APP_KEY");
      expect(run.stderr).not.toMatch(/username/i);
    }
    expect(asked).toEqual([]);
  });

  test("no snippet on the page passes PITHY_APP_TOKEN as a command-line argument", async () => {
    const page = await readFile(PAGE, "utf8");
    expect(page).not.toMatch(/-H\s+"Authorization: Bearer \$\{?PITHY_APP_TOKEN/);
    expect(page).not.toMatch(/-H\s+"x-api-key: \$\{?PITHY_APP_KEY/i);
  });

  test("each `Use it` snippet sends the credential it names: a token as Bearer, a key as x-api-key", async () => {
    const page = await readFile(PAGE, "utf8");
    const section = (page.split(/^## Use it$/m)[1] ?? "").split(/^## /m)[0] ?? "";
    const snippets = [...section.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
    const token = snippets.filter((snippet) => snippet.includes("Authorization: Bearer"));
    const key = snippets.filter((snippet) => snippet.includes("x-api-key:"));
    expect(token).toHaveLength(1);
    expect(key).toHaveLength(1);
    expect(token[0]).not.toContain("PITHY_APP_KEY");
    expect(token[0]).toMatch(/printf 'Authorization: Bearer %s\\n' "\$PITHY_APP_TOKEN" \| curl [^\n]*-H @-/);
    expect(key[0]).not.toContain("PITHY_APP_TOKEN");
    expect(key[0]).toMatch(/printf 'x-api-key: %s\\n' "\$PITHY_APP_KEY" \| curl [^\n]*-H @-/);
  });

  test("a refused mint shows the code and message from its error body, and git asks nobody for a username", async () => {
    answer = {
      status: 404,
      body: { error: { code: "artifacts/not_found", message: "There is no such repository.", status: 404 } },
    };
    const run = await fill(origin);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("artifacts/not_found");
    expect(run.stderr).toContain("There is no such repository.");
    expect(run.stderr).toContain("404");
    expect(run.stderr).not.toMatch(/username/i);
    expect(run.stdout).not.toContain("password=");
  });

  test("an app it cannot reach says so, and git asks nobody for a username", async () => {
    const run = await fill("http://127.0.0.1:1");
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("http://127.0.0.1:1");
    expect(run.stderr).not.toMatch(/username/i);
  });

  test("an answer with no token is refused the same way, never handed to git", async () => {
    answer = { status: 200, body: { nope: true } };
    const run = await fill(origin);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("no token");
    expect(run.stderr).not.toMatch(/username/i);
    expect(run.stdout).not.toContain("password=");
  });

  test("a git that sends no repository path is told to set useHttpPath, and mints nothing", async () => {
    answer = {
      status: 200,
      body: { token: TOKEN, scope: "write", expiresAt: "2027-01-15T08:00:00.000Z", remote: "x" },
    };
    asked.length = 0;
    const run = await fill(origin, false);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("credential.useHttpPath");
    expect(run.stderr).not.toMatch(/username/i);
    expect(asked).toEqual([]);
  });
});
