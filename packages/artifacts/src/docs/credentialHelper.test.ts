// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const asked: { path: string; authorization: string | undefined }[] = [];

function mint(req: IncomingMessage, res: ServerResponse): void {
  asked.push({ path: req.url ?? "", authorization: req.headers.authorization });
  res.writeHead(answer.status, { "content-type": "application/json" });
  res.end(JSON.stringify(answer.body));
}

let server: Server;
let origin: string;
let dir: string;
let helper: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-credential-helper-"));
  helper = join(dir, "git-credential-pithy");
  await writeFile(helper, await helperScript());
  await chmod(helper, 0o755);
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
function fill(appUrl: string, useHttpPath = true): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-c", `credential.helper=${helper}`, "-c", `credential.useHttpPath=${useHttpPath}`, "credential", "fill"],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          XDG_CONFIG_HOME: dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          PITHY_APP_URL: appUrl,
          PITHY_APP_TOKEN: "app-credential",
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
