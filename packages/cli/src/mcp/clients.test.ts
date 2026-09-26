// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { sourcePaths } from "../ci/sourceFiles";
import {
  clientById,
  DOCS_MCP_NAME,
  DOCS_MCP_URL,
  MCP_CLIENTS,
  type McpClient,
  type PlatformPaths,
  scopesOf,
} from "./clients";
import { FIXTURES } from "./fixtures";

/**
 * **The registry is only correct as a set, so it is checked as one.**
 *
 * TypeScript already refuses a row missing a column — that is what the interface is for. What it cannot
 * refuse is a column filled in wrongly: an empty string, a project path written absolute, a platform
 * quietly left resolving like Linux, an entry that forgot the URL. Each of those compiles, ships, and
 * writes a file no editor ever reads. So every column gets a runtime claim here, over every row, and a
 * new client either satisfies all of them or fails this file.
 *
 * The other half is coverage: a row declares paths, and a path nobody wrote a document for has never
 * been exercised. `fixtures.ts` is that corpus and this file holds the two together in both directions —
 * a declared path with no fixture fails, and a fixture for a path no row declares fails too.
 */

const PLATFORMS = ["linux", "darwin", "win32"] as const;

/** The ten ids, as the registry declares them. Named here so a silent rename or drop fails. */
const EXPECTED_IDS = [
  "claude-code",
  "cursor",
  "vscode",
  "gemini",
  "claude-desktop",
  "cline",
  "zed",
  "codex",
  "goose",
  "continue",
];

/** Every declared path on a row, flattened — what a fixture has to cover. */
function everyPlatformPath(paths: PlatformPaths): string[] {
  return PLATFORMS.map((platform) => `${paths[platform].base}/${paths[platform].segments.join("/")}`);
}

describe("the client registry", () => {
  test("declares exactly the ten clients the issue names, in a stable order", () => {
    expect(MCP_CLIENTS.map((client) => client.id)).toEqual(EXPECTED_IDS);
  });

  test("every id is unique — the id is the `--client` value and the status key", () => {
    expect(new Set(MCP_CLIENTS.map((client) => client.id)).size).toBe(MCP_CLIENTS.length);
  });

  test.each(MCP_CLIENTS.map((client) => [client.id, client] as const))(
    "%s fills every column with something usable",
    (_id, client: McpClient) => {
      expect(client.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(client.label.length).toBeGreaterThan(0);
      expect(["json", "jsonc", "toml", "yaml"]).toContain(client.format);
      expect(client.rootKey).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      expect(["map", "list"]).toContain(client.container);
      expect(["native", "mcp-remote"]).toContain(client.transport);
      // A note is what a reader consults instead of trusting the row. An empty one is an unmade claim.
      expect(client.note.length).toBeGreaterThan(20);
      expect(client.note.endsWith(".")).toBe(true);
    },
  );

  test.each(MCP_CLIENTS.map((client) => [client.id, client] as const))(
    "%s declares a project path that is relative, and a user path for all three platforms",
    (_id, client: McpClient) => {
      if (client.project !== null) {
        expect(client.project.length).toBeGreaterThan(0);
        // An absolute segment would escape the project directory `join` resolves against.
        for (const segment of client.project) expect(segment.startsWith("/")).toBe(false);
      }
      for (const platform of PLATFORMS) {
        expect(client.user[platform].segments.length).toBeGreaterThan(0);
        expect(client.detect[platform].segments.length).toBeGreaterThan(0);
      }
    },
  );

  test.each(MCP_CLIENTS.map((client) => [client.id, client] as const))(
    "%s names the documentation server and nothing that could be a credential",
    (_id, client: McpClient) => {
      const rendered = JSON.stringify(client.entry);
      expect(rendered).toContain(DOCS_MCP_URL);
      // Every shape of secret-passing an MCP entry supports. None of them belongs in this table: the
      // OAuth flow is the client's or `mcp-remote`'s, and Pithy holds no token to write.
      for (const key of ["headers", "env", "apiKey", "token", "authorization", "secret", "clientSecret"]) {
        expect(Object.keys(client.entry)).not.toContain(key);
      }
      expect(rendered.toLowerCase()).not.toContain("bearer");
    },
  );

  test("exactly one client is written through the mcp-remote bridge, and it is Claude Desktop", () => {
    // The distinction the issue asks to be recorded in one place. A second row taking the shim is a
    // real change and should be argued for here rather than noticed in a diff.
    const bridged = MCP_CLIENTS.filter((client) => client.transport === "mcp-remote").map((client) => client.id);
    expect(bridged).toEqual(["claude-desktop"]);
  });

  test("a bridged client's entry runs mcp-remote; a native client's entry carries the URL and no command", () => {
    for (const client of MCP_CLIENTS) {
      if (client.transport === "mcp-remote") {
        expect(client.entry.command).toBe("npx");
        expect(client.entry.args).toEqual(["-y", "mcp-remote", DOCS_MCP_URL]);
      } else {
        expect(client.entry.command).toBeUndefined();
        expect(JSON.stringify(client.entry)).not.toContain("mcp-remote");
      }
    }
  });

  test("only the list-shaped client carries its own name in the entry", () => {
    for (const client of MCP_CLIENTS) {
      if (client.container === "list") expect(client.entry.name).toBe(DOCS_MCP_NAME);
    }
  });

  test("a preamble is declared only where a project file is a document in its own right", () => {
    const withPreamble = MCP_CLIENTS.filter((client) => client.preamble !== null).map((client) => client.id);
    expect(withPreamble).toEqual(["continue"]);
  });

  test("scopesOf follows the project column, and a project-less client is user-only", () => {
    expect(scopesOf(clientById("cursor") as McpClient)).toEqual(["project", "user"]);
    expect(scopesOf(clientById("goose") as McpClient)).toEqual(["user"]);
    expect(scopesOf(clientById("claude-desktop") as McpClient)).toEqual(["user"]);
    expect(scopesOf(clientById("cline") as McpClient)).toEqual(["user"]);
  });

  test("clientById answers the declared names and nothing else", () => {
    expect(clientById("codex")?.format).toBe("toml");
    expect(clientById("Codex")).toBeUndefined();
    expect(clientById("nonesuch")).toBeUndefined();
  });
});

describe("the fixture corpus covers the registry", () => {
  test("every declared scope of every client has a fixture", () => {
    const missing: string[] = [];
    for (const client of MCP_CLIENTS) {
      for (const scope of scopesOf(client)) {
        if (FIXTURES[client.id]?.[scope] === undefined) missing.push(`${client.id} ${scope}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("no fixture describes a scope its client does not declare", () => {
    const extra: string[] = [];
    for (const [id, scopes] of Object.entries(FIXTURES)) {
      const client = clientById(id);
      if (client === undefined) {
        extra.push(`${id} (no such client)`);
        continue;
      }
      const declared = new Set<string>(scopesOf(client));
      for (const scope of Object.keys(scopes)) if (!declared.has(scope)) extra.push(`${id} ${scope}`);
    }
    expect(extra).toEqual([]);
  });

  test("every fixture holds a server Pithy did not write, and says which bytes must survive", () => {
    for (const [id, scopes] of Object.entries(FIXTURES)) {
      for (const [scope, fixture] of Object.entries(scopes)) {
        const where = `${id} ${scope}`;
        expect(fixture.neighbor, where).not.toBe(DOCS_MCP_NAME);
        expect(fixture.document, where).toContain(fixture.neighbor);
        expect(fixture.survives.length, where).toBeGreaterThan(0);
        for (const slice of fixture.survives) expect(fixture.document, `${where}: ${slice}`).toContain(slice);
        // A fixture that already mentions us would make every "added" assertion vacuous.
        expect(fixture.document, where).not.toContain(DOCS_MCP_URL);
      }
    }
  });

  test("every platform path a row declares is one of the bases home.ts resolves", () => {
    const bases = new Set(["home", "config", "appSupport", "appData"]);
    for (const client of MCP_CLIENTS) {
      for (const path of [...everyPlatformPath(client.user), ...everyPlatformPath(client.detect)]) {
        expect(bases, `${client.id}: ${path}`).toContain(path.split("/")[0]);
      }
    }
  });
});

describe("the URL is stated once", () => {
  test("no module spells the docs server out — everything reads it off the registry", () => {
    // `clients.ts` is where the address lives, so pointing the command at a staging server is one edit.
    // Everywhere else imports `DOCS_MCP_URL`, and a second literal is the drift this catches. The sweep
    // is the whole CLI source rather than this directory: a snippet rendered in `commands/docs.ts` or a
    // sentence in a doctor check is exactly where a copy would land.
    const root = join(import.meta.dirname, "..");
    const paths = sourcePaths(root);
    // The walk itself, asserted: a sweep that found nothing would pass this test over nothing.
    expect(paths.length).toBeGreaterThan(250);
    const spelt = paths
      .filter((path) => path !== join(root, "mcp", "clients.ts"))
      // Comments blanked first: the rule is about code, and a writer explaining the shape it renders is
      // prose. Every sweep in `src/ci` draws the line in the same place, with the same helper.
      .filter((path) => blankComments(readFileSync(path, "utf8")).includes(DOCS_MCP_URL))
      .map((path) => relative(root, path));
    expect(spelt).toEqual([]);
  });
});
