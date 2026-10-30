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

/** The line a detected, unconnected client gets: its name, every file read for it, and the command. */
function line(label: string, id: string, ...paths: string[]): string {
  return `${label}, nothing in ${paths.join(" or ")} — pithy docs connect --client ${id}`;
}

/** Cursor's two files on this machine, project first — the order the check reads them in. */
function cursorPaths(): string[] {
  return [join(dir, ".cursor", "mcp.json"), join(home, ".cursor", "mcp.json")];
}

/** Codex's two, the same way. */
function codexPaths(): string[] {
  return [join(dir, ".codex", "config.toml"), join(home, ".codex", "config.toml")];
}

/** The entry a connected client carries, written as that client's own file. */
async function connected(path: string, rootKey: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify({ [rootKey]: { [DOCS_MCP_NAME]: { url: DOCS_MCP_URL } } }, null, 2)}\n`);
}

describe("checkDocsMcp", () => {
  test("a machine running none of the clients is `ok`, because nothing about it is wrong", async () => {
    expect(await checkDocsMcp(dir, options())).toEqual({ state: "ok", findings: [], clients: [] });
  });

  test("a detected client with no entry names itself and the command that connects it", async () => {
    await install(".cursor");
    const check = await checkDocsMcp(dir, options());
    expect(check.state).toBe("unconnected");
    expect(check.findings).toEqual([line("Cursor", "cursor", ...cursorPaths())]);
  });

  test("every detected client gets its own line, each naming its own id", async () => {
    await install(".cursor");
    await install(".codex");
    const check = await checkDocsMcp(dir, options());
    expect(check.findings).toEqual([
      line("Cursor", "cursor", ...cursorPaths()),
      line("Codex CLI", "codex", ...codexPaths()),
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
    expect(await checkDocsMcp(dir, options())).toEqual({ state: "ok", findings: [], clients: [] });
  });

  test("the project scope counts too — a client is connected wherever its entry is", async () => {
    await install(".cursor");
    await connected(join(dir, ".cursor", "mcp.json"), "mcpServers");
    expect(await checkDocsMcp(dir, options())).toEqual({ state: "ok", findings: [], clients: [] });
  });

  test("one connected client does not answer for another", async () => {
    await install(".cursor");
    await install(".codex");
    await connected(join(home, ".cursor", "mcp.json"), "mcpServers");
    const check = await checkDocsMcp(dir, options());
    expect(check).toEqual({
      state: "unconnected",
      findings: [line("Codex CLI", "codex", ...codexPaths())],
      clients: [{ client: "codex", label: "Codex CLI", paths: codexPaths() }],
    });
  });

  test("a configuration that will not parse is not a connection, and never throws", async () => {
    await install(".cursor");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(join(home, ".cursor", "mcp.json"), "{ not json");
    const check = await checkDocsMcp(dir, options());
    expect(check).toEqual({
      state: "unconnected",
      findings: [line("Cursor", "cursor", ...cursorPaths())],
      clients: [{ client: "cursor", label: "Cursor", paths: cursorPaths() }],
    });
  });

  test("with CLAUDE_CONFIG_DIR set, an entry only in `~/.claude.json` is not the profile in use (#900)", async () => {
    // Connected in the default profile, running in another: the profile Claude Code reads has no entry.
    const profile = join(home, ".claude-work");
    await mkdir(profile, { recursive: true });
    await connected(join(home, ".claude.json"), "mcpServers");
    const moved: McpOptions = {
      projectDir: dir,
      home: { platform: "linux", homedir: home, env: { CLAUDE_CONFIG_DIR: profile } },
    };
    const paths = [join(dir, ".mcp.json"), join(profile, ".claude.json")];
    expect(await checkDocsMcp(dir, moved)).toEqual({
      state: "unconnected",
      findings: [line("Claude Code", "claude-code", ...paths)],
      clients: [{ client: "claude-code", label: "Claude Code", paths }],
    });
    // And the same machine without the variable is connected, which is what makes the line above the variable's.
    expect((await checkDocsMcp(dir, options())).state).toBe("ok");
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
    expect(describeDocsMcp({ state: "ok", findings: [], clients: [] })).toBe(
      "Every AI client detected here can read the Pithy docs.",
    );
  });

  test("counts the clients, and one client is singular", () => {
    expect(
      describeDocsMcp({
        state: "unconnected",
        findings: [line("Cursor", "cursor", "/p/.cursor/mcp.json")],
        clients: [{ client: "cursor", label: "Cursor", paths: ["/p/.cursor/mcp.json"] }],
      }),
    ).toBe("1 detected client cannot read the Pithy docs.");
  });

  test("two or more are plural", () => {
    expect(
      describeDocsMcp({
        state: "unconnected",
        findings: [
          line("Cursor", "cursor", "/p/.cursor/mcp.json"),
          line("Codex CLI", "codex", "/p/.codex/config.toml"),
        ],
        clients: [
          { client: "cursor", label: "Cursor", paths: ["/p/.cursor/mcp.json"] },
          { client: "codex", label: "Codex CLI", paths: ["/p/.codex/config.toml"] },
        ],
      }),
    ).toBe("2 detected clients cannot read the Pithy docs.");
  });

  test("a check that could not run claims nothing about the machine", () => {
    expect(describeDocsMcp({ state: "could-not-check", findings: [], clients: [] })).toBe(
      "Could not read the AI clients' configuration.",
    );
  });
});
