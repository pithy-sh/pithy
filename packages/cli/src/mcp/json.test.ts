// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { DOCS_MCP_NAME, DOCS_MCP_URL, MCP_CLIENTS, type McpClient, scopesOf } from "./clients";
import { urlKeyOf } from "./document";
import { FIXTURES, type Fixture } from "./fixtures";
import { jsonWriter } from "./json";

/**
 * **The writer is tested over the corpus, not over an example.** Seven of the ten clients keep their
 * configuration in JSON or JSONC, under three different root keys, and the thing that would break is the
 * same in all of them: a document the adopter wrote, holding a server Pithy did not put there. So every
 * claim below runs against every one of those clients in every scope it declares, driven off the
 * registry and `fixtures.ts` — a hand-written case per client would prove the property for the client
 * somebody remembered and say nothing about the eighth row.
 *
 * **`survives` is the assertion that matters.** Each fixture names the exact bytes belonging to its
 * owner, and every merge, re-merge and removal here checks they are still present, verbatim, afterwards.
 * `claude-code user` is the sharp end of it: that document is `~/.claude.json`, Claude Code's own state
 * file, and `numStartups` and `projects` sit beside the servers. Losing one of them is the worst thing
 * this command could do, so it is asserted like everything else rather than trusted.
 *
 * **Refusal is checked for what it does not say.** These files sit next to credentials, and a parser's
 * own message tends to echo the line it choked on, so the malformed document carries a secret-shaped
 * string and the test asserts the reason never contains it.
 */

/** A URL that is not ours, for the document that points somewhere else. */
const ELSEWHERE = "https://example.invalid/mcp";

/** A secret-shaped string in a broken document — nothing a refusal says may repeat it. */
const NEVER_ECHOED = "sk-live-must-never-be-echoed";

/** The rows this writer serves: every client whose configuration is JSON or JSONC. */
const JSON_CLIENTS = MCP_CLIENTS.filter((client) => client.format === "json" || client.format === "jsonc");

/** One case per client per declared scope, with the document that scope is tested against. */
const CASES = JSON_CLIENTS.flatMap((client) =>
  scopesOf(client).map((scope) => {
    const fixture = FIXTURES[client.id]?.[scope];
    if (fixture === undefined) throw new Error(`${client.id} ${scope} has no fixture to test against`);
    return { label: `${client.id} ${scope}`, client, fixture };
  }),
);

/** The cases as vitest wants them — the label first, so a failure names the client and the scope. */
const EACH = CASES.map((entry) => [entry.label, entry] as const);

/** The merged bytes, or a failure naming the client rather than a type error twenty lines later. */
function mergedBytes(document: string | null, client: McpClient): string {
  const result = jsonWriter.merge(document, client);
  if (result.state === "refused") throw new Error(`${client.id}: refused — ${result.reason}`);
  return result.document;
}

describe("the JSON writer sets one entry and leaves the rest of the file alone", () => {
  test("it covers every JSON and JSONC client in the registry", () => {
    // Non-vacuity. A filter that matched nothing would run none of the claims below and pass.
    expect(JSON_CLIENTS.map((client) => client.id)).toEqual([
      "claude-code",
      "cursor",
      "vscode",
      "gemini",
      "claude-desktop",
      "cline",
      "zed",
    ]);
    expect(CASES.length).toBe(12);
  });

  test.each(EACH)("%s gains the entry, and the adopter's own server survives it", (_label, { client, fixture }) => {
    const result = jsonWriter.merge(fixture.document, client);
    expect(result.state).toBe("merged");
    if (result.state === "refused") return;
    expect(result.outcome).toBe("added");
    for (const slice of fixture.survives) expect(result.document).toContain(slice);
    expect(result.document).toContain(fixture.neighbor);
    expect(result.document).toContain(DOCS_MCP_URL);
    expect(result.document.endsWith("\n")).toBe(true);
    expect(result.document.endsWith("\n\n")).toBe(false);
  });

  test.each(EACH)("%s reads the entry back as current, at the address we wrote", (_label, { client, fixture }) => {
    const reading = jsonWriter.read(mergedBytes(fixture.document, client), client);
    expect(reading.state).toBe("read");
    if (reading.state === "refused") return;
    expect(reading.entry?.current).toBe(true);
    // Claude Desktop is the bridged row: its address is an argument to `npx`, so there is no key to read.
    expect(reading.entry?.url).toBe(urlKeyOf(client) === null ? null : DOCS_MCP_URL);
  });

  test.each(EACH)("%s says nothing about pithy before anything is written", (_label, { client, fixture }) => {
    const reading = jsonWriter.read(fixture.document, client);
    expect(reading.state).toBe("read");
    if (reading.state === "refused") return;
    expect(reading.entry).toBeNull();
  });

  test.each(EACH)("%s merged twice is unchanged, and byte for byte the same file", (_label, { client, fixture }) => {
    const once = mergedBytes(fixture.document, client);
    const again = jsonWriter.merge(once, client);
    expect(again.state).toBe("merged");
    if (again.state === "refused") return;
    expect(again.outcome).toBe("unchanged");
    // The input bytes, not a re-rendering of them: a second run must not touch the file at all.
    expect(again.document).toBe(once);
  });

  test.each(EACH)("%s pointing somewhere else is corrected, not duplicated", (_label, { client, fixture }) => {
    const stale = mergedBytes(fixture.document, client).replaceAll(DOCS_MCP_URL, ELSEWHERE);
    const result = jsonWriter.merge(stale, client);
    expect(result.state).toBe("merged");
    if (result.state === "refused") return;
    expect(result.outcome).toBe("updated");
    expect(result.document).not.toContain(ELSEWHERE);
    expect(result.document).toContain(DOCS_MCP_URL);
    for (const slice of fixture.survives) expect(result.document).toContain(slice);
    const reading = jsonWriter.read(result.document, client);
    expect(reading.state === "read" && reading.entry?.current).toBe(true);
  });

  test.each(EACH)("%s loses only our entry when it is removed", (_label, { client, fixture }) => {
    const result = jsonWriter.remove(mergedBytes(fixture.document, client), client);
    expect(result.state).toBe("merged");
    if (result.state === "refused") return;
    expect(result.outcome).toBe("removed");
    expect(result.document).not.toContain(DOCS_MCP_URL);
    expect(result.document).not.toContain(`"${DOCS_MCP_NAME}"`);
    for (const slice of fixture.survives) expect(result.document).toContain(slice);
    expect(result.document).toContain(fixture.neighbor);
    expect(result.document.endsWith("\n")).toBe(true);
  });

  test.each(EACH)("%s without our entry is absent on removal, and untouched", (_label, { client, fixture }) => {
    const result = jsonWriter.remove(fixture.document, client);
    expect(result.state).toBe("merged");
    if (result.state === "refused") return;
    expect(result.outcome).toBe("absent");
    expect(result.document).toBe(fixture.document);
  });

  test.each(EACH)("%s with no file at all gets exactly the snippet --print shows", (_label, { client }) => {
    const created = jsonWriter.merge(null, client);
    expect(created.state).toBe("merged");
    if (created.state === "refused") return;
    expect(created.outcome).toBe("added");
    expect(created.document).toBe(jsonWriter.snippet(client));
    // And the snippet is a document in its own right: reading it back finds a current entry.
    const reading = jsonWriter.read(created.document, client);
    expect(reading.state === "read" && reading.entry?.current).toBe(true);
  });

  test.each(EACH)("%s prefixes a preamble when one is handed over", (_label, { client }) => {
    const preamble = "// Written by `pithy docs connect`.\n";
    const created = jsonWriter.merge(null, client, preamble);
    expect(created.state === "merged" && created.document).toBe(preamble + jsonWriter.snippet(client));
  });
});

describe("the JSON writer adds the root key only when it has to", () => {
  test.each(JSON_CLIENTS.map((client) => [client.id, client] as const))(
    "%s gets its root key created, and the keys already in the file stay",
    (_id, client: McpClient) => {
      const result = jsonWriter.merge(`{\n  "numStartups": 42\n}\n`, client);
      expect(result.state).toBe("merged");
      if (result.state === "refused") return;
      expect(result.outcome).toBe("added");
      expect(result.document).toContain(`"numStartups": 42`);
      expect(result.document).toContain(`"${client.rootKey}"`);
      expect(jsonWriter.read(result.document, client).state).toBe("read");
    },
  );

  test.each(JSON_CLIENTS.map((client) => [client.id, client] as const))(
    "%s with a root key but no servers in it is absent rather than refused",
    (_id, client: McpClient) => {
      const document = `{\n  "${client.rootKey}": {}\n}\n`;
      const removed = jsonWriter.remove(document, client);
      expect(removed.state === "merged" && removed.outcome).toBe("absent");
      expect(removed.state === "merged" && removed.document).toBe(document);
      expect(jsonWriter.read(document, client)).toEqual({ state: "read", entry: null });
    },
  );
});

describe("the JSON writer refuses a document it cannot read", () => {
  /** The documents no write may be attempted against, and the client each is malformed for. */
  const UNREADABLE = (client: McpClient): readonly (readonly [string, string])[] => [
    ["not JSON at all", `{ "${client.rootKey}": { "vault": { "apiKey": "${NEVER_ECHOED}" }`],
    ["a top level that is an array", `[{ "apiKey": "${NEVER_ECHOED}" }]`],
    ["a top level that is a string", `"${NEVER_ECHOED}"`],
    ["a root key holding a list", `{ "${client.rootKey}": ["${NEVER_ECHOED}"] }`],
    ["a root key holding a string", `{ "${client.rootKey}": "${NEVER_ECHOED}" }`],
    ["a pithy entry that is not an object", `{ "${client.rootKey}": { "${DOCS_MCP_NAME}": "${NEVER_ECHOED}" } }`],
  ];

  test.each(JSON_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: every operation refuses, and offers no bytes to write",
    (_id, client: McpClient) => {
      for (const [what, document] of UNREADABLE(client)) {
        for (const result of [
          jsonWriter.merge(document, client),
          jsonWriter.remove(document, client),
          jsonWriter.read(document, client),
        ]) {
          expect(result.state, what).toBe("refused");
          expect(result, what).not.toHaveProperty("document");
        }
      }
    },
  );

  test.each(JSON_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: the reason is one line and never repeats what the file said",
    (_id, client: McpClient) => {
      for (const [what, document] of UNREADABLE(client)) {
        const result = jsonWriter.merge(document, client);
        if (result.state !== "refused") throw new Error(`${client.id} did not refuse ${what}`);
        expect(result.reason, what).not.toContain(NEVER_ECHOED);
        expect(result.reason, what).not.toContain("\n");
        expect(result.reason.length, what).toBeGreaterThan(20);
        expect(result.reason.endsWith("."), what).toBe(true);
      }
    },
  );
});

describe("a JSONC document keeps its comments", () => {
  /** The two rows whose format tolerates comments, and whose fixtures carry one. */
  const COMMENTED = CASES.filter((entry) => entry.fixture.survives.some((slice) => slice.startsWith("//")));

  test("both commented fixtures are exercised", () => {
    expect(COMMENTED.map((entry) => entry.label)).toEqual(["vscode project", "zed project"]);
  });

  test.each(COMMENTED.map((entry) => [entry.label, entry] as const))(
    "%s keeps the adopter's comment through a merge and a removal",
    (_label, { client, fixture }: { client: McpClient; fixture: Fixture }) => {
      const comment = fixture.survives.find((slice) => slice.startsWith("//"));
      expect(comment).toBeDefined();
      const merged = mergedBytes(fixture.document, client);
      expect(merged).toContain(comment);
      const removed = jsonWriter.remove(merged, client);
      expect(removed.state === "merged" && removed.document).toContain(comment);
    },
  );
});
