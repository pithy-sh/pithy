// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { clientById, DOCS_MCP_NAME, DOCS_MCP_URL, MCP_CLIENTS, type McpClient, type Scope, scopesOf } from "./clients";
import { FIXTURES } from "./fixtures";
import { tomlWriter } from "./toml";

/**
 * **The corpus decides what passes, not a document written to suit the writer.**
 *
 * Every case below runs over `fixtures.ts` rather than over a hand-rolled snippet, because the property
 * the issue turns on is not "the entry came out right" — it is "the adopter's file came out unharmed",
 * and only a realistic document can state that. So the shape is a loop over the registry's TOML rows and
 * their declared scopes, asserting each fixture's `survives` bytes verbatim after every operation. A
 * second TOML client is a new row, not a new test.
 *
 * **The rest is refusal.** A line-based splice is only safe on files whose structure it can read, so the
 * documents that it cannot read are enumerated here one by one, and each carries a token-shaped string
 * that the reason line must never echo — these files sit beside credentials, and a parser's own message
 * is the usual way one reaches a terminal.
 */

/** The TOML rows, paired with every scope the registry declares for them. */
const CASES: readonly (readonly [string, McpClient, Scope])[] = MCP_CLIENTS.filter(
  (client) => client.format === "toml",
).flatMap((client) => scopesOf(client).map((scope) => [`${client.id} ${scope}`, client, scope] as const));

/** The one row this writer serves today, for the cases that are about its own spellings. */
const CODEX = clientById("codex") as McpClient;

/** A string no refusal may repeat — stood in for the credentials these files really sit beside. */
const SECRET = "hunter2-must-not-be-echoed";

/**
 * The document, read back as tables.
 *
 * Deliberately a second, dumber reader than the writer's own: it walks headers and collects the
 * non-blank lines under each, with top-level assignments under `""`. That is what proves the block
 * landed in a legal place — a bare key appended after somebody else's header belongs to their table,
 * and this reader would report it there.
 */
function tables(document: string): Record<string, string[]> {
  const out: Record<string, string[]> = { "": [] };
  let current = "";
  for (const line of document.split("\n")) {
    const header = /^\[(.+)\]$/.exec(line.trim());
    if (header !== null) {
      current = header[1] as string;
      out[current] = [];
      continue;
    }
    if (line.trim().length > 0) (out[current] as string[]).push(line.trim());
  }
  return out;
}

/** The table a merge writes, as the document itself spells it. */
function target(client: McpClient): string {
  return `${client.rootKey}.${DOCS_MCP_NAME}`;
}

/** A merged document, or a failed assertion naming the refusal instead. */
function mergedDocument(document: string | null, client: McpClient): string {
  const result = tomlWriter.merge(document, client);
  if (result.state === "refused") throw new Error(`refused: ${result.reason}`);
  return result.document;
}

describe("the TOML writer renders", () => {
  test("a snippet that declares the server as its own table, ending in one newline", () => {
    expect(tomlWriter.snippet(CODEX)).toBe(`[${target(CODEX)}]\nurl = "${DOCS_MCP_URL}"\n`);
  });

  test("merging into a file that does not exist is exactly the snippet, so --print cannot drift", () => {
    const result = tomlWriter.merge(null, CODEX);
    expect(result).toEqual({ state: "merged", outcome: "added", document: tomlWriter.snippet(CODEX) });
  });

  test("a preamble is placed ahead of that snippet and nothing else changes", () => {
    const result = tomlWriter.merge(null, CODEX, "# written by pithy\n");
    expect(result.state === "merged" && result.document).toBe(`# written by pithy\n${tomlWriter.snippet(CODEX)}`);
  });

  test("every value type the registry could grow, and the escapes a string needs", () => {
    const rich: McpClient = {
      ...CODEX,
      entry: { url: DOCS_MCP_URL, enabled: true, timeout: 300, args: ["-y", "bridge"], note: 'a "quoted" c:\\path' },
    };
    expect(tomlWriter.snippet(rich)).toBe(
      `[${target(CODEX)}]\n` +
        `url = "${DOCS_MCP_URL}"\n` +
        "enabled = true\n" +
        "timeout = 300\n" +
        'args = ["-y", "bridge"]\n' +
        'note = "a \\"quoted\\" c:\\\\path"\n',
    );
  });

  test.each([
    ["a nested object", { nested: { deep: true } }],
    ["a fractional number", { timeout: 1.5 }],
    ["an array of numbers", { ports: [1, 2] }],
    ["a null", { note: null }],
  ])("throws rather than writing a broken file for %s", (_what, extra: Record<string, unknown>) => {
    const odd: McpClient = { ...CODEX, entry: { url: DOCS_MCP_URL, ...extra } };
    expect(() => tomlWriter.snippet(odd)).toThrow(PithyError);
  });
});

describe.each(CASES)("the TOML writer over the %s fixture", (name, client, scope) => {
  const fixture = FIXTURES[client.id]?.[scope];
  if (fixture === undefined) throw new Error(`no fixture for ${name}`);

  test("adds the entry, and every neighboring byte survives verbatim", () => {
    const result = tomlWriter.merge(fixture.document, client);
    expect(result.state === "merged" && result.outcome).toBe("added");
    const document = mergedDocument(fixture.document, client);
    for (const slice of fixture.survives) expect(document).toContain(slice);
    expect(document).toContain(fixture.neighbor);
  });

  test("puts the address under its own table header, not into the table above it", () => {
    const read = tables(mergedDocument(fixture.document, client));
    expect(read[target(client)]).toEqual([`url = "${DOCS_MCP_URL}"`]);
    // Nobody else's table gained a line — the neighbor's is exactly what the fixture declared.
    expect(read[`${client.rootKey}.${fixture.neighbor}`]?.join("\n")).not.toContain(DOCS_MCP_URL);
  });

  test("ends the file with exactly one newline and never a blank line doubled", () => {
    const document = mergedDocument(fixture.document, client);
    expect(document.endsWith("\n")).toBe(true);
    expect(document.endsWith("\n\n")).toBe(false);
    expect(document).not.toContain("\n\n\n");
  });

  test("a second merge reports unchanged and returns the input bytes", () => {
    const once = mergedDocument(fixture.document, client);
    const again = tomlWriter.merge(once, client);
    expect(again.state === "merged" && again.outcome).toBe("unchanged");
    expect(again.state === "merged" && again.document).toBe(once);
  });

  test("an entry pointing elsewhere is corrected, and says it was updated", () => {
    const stale = mergedDocument(fixture.document, client).replace(DOCS_MCP_URL, "https://example.test/mcp");
    const result = tomlWriter.merge(stale, client);
    expect(result.state === "merged" && result.outcome).toBe("updated");
    expect(result.state === "merged" && result.document).toBe(mergedDocument(fixture.document, client));
  });

  test("removes the entry, leaves no doubled blank line, and every neighboring byte survives", () => {
    const result = tomlWriter.remove(mergedDocument(fixture.document, client), client);
    expect(result.state === "merged" && result.outcome).toBe("removed");
    if (result.state === "refused") return;
    expect(result.document).not.toContain(DOCS_MCP_URL);
    expect(result.document).not.toContain(target(client));
    expect(result.document).not.toContain("\n\n\n");
    for (const slice of fixture.survives) expect(result.document).toContain(slice);
  });

  test("removing from a document that never mentioned Pithy is absent, and changes no byte", () => {
    const result = tomlWriter.remove(fixture.document, client);
    expect(result).toEqual({ state: "merged", outcome: "absent", document: fixture.document });
  });

  test("reads nothing out of the untouched document, and the entry back out of a merged one", () => {
    expect(tomlWriter.read(fixture.document, client)).toEqual({ state: "read", entry: null });
    expect(tomlWriter.read(mergedDocument(fixture.document, client), client)).toEqual({
      state: "read",
      entry: { url: DOCS_MCP_URL, current: true },
    });
  });

  test("an entry pointing elsewhere reads back as not current", () => {
    const stale = mergedDocument(fixture.document, client).replace(DOCS_MCP_URL, "https://example.test/mcp");
    expect(tomlWriter.read(stale, client)).toEqual({
      state: "read",
      entry: { url: "https://example.test/mcp", current: false },
    });
  });
});

describe("the TOML writer and the keys around it", () => {
  test("a top-level key above the tables stays top-level after a merge", () => {
    const fixture = FIXTURES.codex?.user;
    if (fixture === undefined) throw new Error("no codex user fixture");
    const read = tables(mergedDocument(fixture.document, CODEX));
    expect(read[""]).toEqual(['model = "o3"', 'approval_policy = "on-request"']);
    expect(read.tui).toEqual(["notifications = true"]);
  });

  test("a table below ours is still a table below ours after a merge and a removal", () => {
    const fixture = FIXTURES.codex?.user;
    if (fixture === undefined) throw new Error("no codex user fixture");
    const removed = tomlWriter.remove(mergedDocument(fixture.document, CODEX), CODEX);
    expect(removed.state === "merged" && removed.document).toBe(fixture.document);
  });

  test("an empty file takes the block on its own", () => {
    expect(mergedDocument("", CODEX)).toBe(tomlWriter.snippet(CODEX));
  });

  test("a document holding only our table comes back empty when it is removed", () => {
    const result = tomlWriter.remove(tomlWriter.snippet(CODEX), CODEX);
    expect(result).toEqual({ state: "merged", outcome: "removed", document: "" });
  });
});

/** Each document this writer must refuse, and the operator-facing word its reason ought to carry. */
const REFUSALS: readonly (readonly [string, string])[] = [
  ["the servers key is an inline table", `mcp_servers = { pithy = { url = "${SECRET}" } }\n`],
  ["the servers key is assigned with a dotted key", `mcp_servers.pithy = { url = "${SECRET}" }\n`],
  ["the servers key is assigned with no space", `mcp_servers={ token = "${SECRET}" }\n`],
  ["our table is an array of tables", `[[mcp_servers.pithy]]\nurl = "${SECRET}"\n`],
  ["our table is declared twice", `[mcp_servers.pithy]\nurl = "${SECRET}"\n\n[mcp_servers.pithy]\nurl = "b"\n`],
  ["the file holds a multi-line basic string", `note = """\n${SECRET}\n"""\n\n[tui]\nx = 1\n`],
  ["the file holds a multi-line literal string", `note = '''\n${SECRET}\n'''\n\n[tui]\nx = 1\n`],
  ["our table is spelled with every key quoted", `["mcp_servers"."pithy"]\nurl = "${SECRET}"\n`],
  ["our table is spelled with the name quoted", `[mcp_servers."pithy"]\nurl = "${SECRET}"\n`],
  ["our name is a key inside the servers table", `[mcp_servers]\npithy = { url = "${SECRET}" }\n`],
  ["a bracketed line is not a key Pithy can read", `[tui]\nx = [\n  1, 2\n]\n[1, 2]\n`],
];

describe("the TOML writer refuses what it cannot read", () => {
  test.each(REFUSALS)("refuses every operation when %s", (_what, document: string) => {
    for (const result of [
      tomlWriter.merge(document, CODEX),
      tomlWriter.remove(document, CODEX),
      tomlWriter.read(document, CODEX),
    ]) {
      expect(result.state).toBe("refused");
    }
  });

  test.each(REFUSALS)("gives one line that quotes nothing from the file when %s", (_what, document: string) => {
    const result = tomlWriter.merge(document, CODEX);
    if (result.state !== "refused") throw new Error("expected a refusal");
    expect(result.reason).not.toContain("\n");
    expect(result.reason.length).toBeGreaterThan(20);
    expect(result.reason.endsWith(".")).toBe(true);
    expect(result.reason).not.toContain(SECRET);
  });

  test("a key named like the root key inside somebody else's table is not a refusal", () => {
    // The inline-assignment refusal is about the *top level*, where the root key would really be
    // defined. Refusing on the word wherever it appears would lock an adopter out of their own file.
    const document = `[tui]\nmcp_servers = 3\n\n[mcp_servers.playwright]\ncommand = "npx"\n`;
    const result = tomlWriter.merge(document, CODEX);
    expect(result.state === "merged" && result.outcome).toBe("added");
  });

  test("a comment after a table header is still a table header, and the block is still ours", () => {
    // Recognizing the header is what keeps the comment from being read as a second, nameless table.
    // Reporting it as not current is the other half: the block belongs to Pithy, so a merge rewrites
    // it whole and the comment goes — and `read` has to say what a merge would do, not something kinder.
    const document = `[${target(CODEX)}] # mine\nurl = "${DOCS_MCP_URL}"\n\n[tui]\nx = 1\n`;
    expect(tomlWriter.read(document, CODEX)).toEqual({ state: "read", entry: { url: DOCS_MCP_URL, current: false } });
    const result = tomlWriter.merge(document, CODEX);
    expect(result.state === "merged" && result.outcome).toBe("updated");
    expect(result.state === "merged" && result.document).toBe(
      `[${target(CODEX)}]\nurl = "${DOCS_MCP_URL}"\n\n[tui]\nx = 1\n`,
    );
  });
});
