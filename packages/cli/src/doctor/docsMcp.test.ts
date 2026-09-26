// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DOCS_MCP_NAME, DOCS_MCP_URL } from "../mcp/clients";
import type { McpOptions } from "../mcp/connect";
import { checkDocsMcp, describeDocsMcp } from "./docsMcp";

/**
 * What the check establishes, against real directories and real files.
 *
 * **Every fixture builds its own home.** `mcp/home.ts` refuses the operator's own under vitest (#200), and
 * that refusal is the reason this suite never mocks: a test that forgets the seam fails loudly instead of
 * reading — or one day writing — the developer's actual `~/.cursor/mcp.json`. So `options()` hands the
 * check a throwaway directory, and detection is a directory this test made rather than a stub.
 *
 * **Cursor and Codex CLI are the two rows used**, because between them they cover what the check has to
 * get right: both declare a project scope as well as a user one, they detect on different paths, and
 * neither shares a file with anything else here. The other eight are absent by construction — an empty
 * home detects nothing — which is what makes "an undetected client is never reported" assertable.
 */

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-docsmcp-"));
  home = await mkdtemp(join(tmpdir(), "pithy-docsmcp-home-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** The seams, as a function: `home` is a fresh directory per test, so a captured const would go stale. */
function options(): McpOptions {
  return { projectDir: dir, home: { platform: "linux", homedir: home, env: {} } };
}

/** Make the directory whose existence is a client's "installed here". */
async function install(...segments: string[]): Promise<void> {
  await mkdir(join(home, ...segments), { recursive: true });
}

/** The entry a connected client carries, written as that client's own file. */
async function connected(path: string, rootKey: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify({ [rootKey]: { [DOCS_MCP_NAME]: { url: DOCS_MCP_URL } } }, null, 2)}\n`);
}

describe("checkDocsMcp", () => {
  test("a machine running none of the clients is `ok`, because nothing about it is wrong", async () => {
    expect(await checkDocsMcp(dir, options())).toEqual({ state: "ok", findings: [] });
  });

  test("a detected client with no entry names itself and the command that connects it", async () => {
    await install(".cursor");
    const check = await checkDocsMcp(dir, options());
    expect(check.state).toBe("unconnected");
    expect(check.findings).toEqual(["Cursor — pithy docs connect --client cursor"]);
  });

  test("every detected client gets its own line, each naming its own id", async () => {
    await install(".cursor");
    await install(".codex");
    const check = await checkDocsMcp(dir, options());
    expect(check.findings).toEqual([
      "Cursor — pithy docs connect --client cursor",
      "Codex CLI — pithy docs connect --client codex",
    ]);
  });

  test("a client that is not installed here is never reported, connected or not", async () => {
    await install(".cursor");
    const check = await checkDocsMcp(dir, options());
    expect(check.findings.join("\n")).not.toMatch(/--client (?!cursor)/);
  });

  test("a detected client whose user configuration carries the entry contributes nothing", async () => {
    await install(".cursor");
    await connected(join(home, ".cursor", "mcp.json"), "mcpServers");
    expect(await checkDocsMcp(dir, options())).toEqual({ state: "ok", findings: [] });
  });

  test("the project scope counts too — a client is connected wherever its entry is", async () => {
    await install(".cursor");
    await connected(join(dir, ".cursor", "mcp.json"), "mcpServers");
    expect(await checkDocsMcp(dir, options())).toEqual({ state: "ok", findings: [] });
  });

  test("one connected client does not answer for another", async () => {
    await install(".cursor");
    await install(".codex");
    await connected(join(home, ".cursor", "mcp.json"), "mcpServers");
    const check = await checkDocsMcp(dir, options());
    expect(check).toEqual({ state: "unconnected", findings: ["Codex CLI — pithy docs connect --client codex"] });
  });

  test("a configuration that will not parse is not a connection, and never throws", async () => {
    await install(".cursor");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(join(home, ".cursor", "mcp.json"), "{ not json");
    const check = await checkDocsMcp(dir, options());
    expect(check).toEqual({ state: "unconnected", findings: ["Cursor — pithy docs connect --client cursor"] });
  });

  test("nothing is created — a check that repaired the machine would not be a diagnostic", async () => {
    await install(".cursor");
    await checkDocsMcp(dir, options());
    await expect(rm(join(home, ".cursor", "mcp.json"))).rejects.toThrow();
    await expect(rm(join(dir, ".cursor"), { recursive: true })).rejects.toThrow();
  });
});

describe("describeDocsMcp", () => {
  test("says nothing is wrong when every detected client can read the docs", () => {
    expect(describeDocsMcp({ state: "ok", findings: [] })).toBe(
      "Every AI client detected here can read the Pithy docs.",
    );
  });

  test("counts the clients, and one client is singular", () => {
    expect(describeDocsMcp({ state: "unconnected", findings: ["Cursor — pithy docs connect --client cursor"] })).toBe(
      "1 detected client cannot read the Pithy docs.",
    );
  });

  test("two or more are plural", () => {
    expect(
      describeDocsMcp({
        state: "unconnected",
        findings: ["Cursor — pithy docs connect --client cursor", "Codex CLI — pithy docs connect --client codex"],
      }),
    ).toBe("2 detected clients cannot read the Pithy docs.");
  });

  test("a check that could not run claims nothing about the machine", () => {
    expect(describeDocsMcp({ state: "could-not-check", findings: [] })).toBe(
      "Could not read the AI clients' configuration.",
    );
  });
});
