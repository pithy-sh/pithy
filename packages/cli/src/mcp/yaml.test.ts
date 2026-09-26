// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { clientById, DOCS_MCP_NAME, DOCS_MCP_URL, MCP_CLIENTS, type McpClient, type Scope, scopesOf } from "./clients";
import type { Merged, MergeResult, Removed, RemoveResult } from "./document";
import { FIXTURES, type Fixture } from "./fixtures";
import { yamlWriter } from "./yaml";

/**
 * **The claim under test is not "it wrote YAML" — it is "it wrote nothing else".**
 *
 * The writer is a line editor precisely so an adopter's other servers keep their own quoting, comments
 * and line breaks, and the only way to hold it to that is to assert those bytes are still there
 * afterwards. So every corpus case merges, re-merges and removes, and checks the fixture's `survives`
 * slices each time. A test that only parsed the result back would pass on a document that had been
 * reflowed end to end, which is the failure this file exists to catch.
 *
 * The other half is the refusals. They are enumerated rather than sampled, because each one is a shape
 * the editor genuinely cannot read, and a refusal that quietly stopped firing would turn into a write
 * over a file Pithy does not own. Each is asserted for all three operations, and each reason is checked
 * for being one line that says nothing about what the file contains.
 */

/** The rows this writer serves. Read off the registry, so an eleventh YAML client is tested by landing. */
const YAML_CLIENTS = MCP_CLIENTS.filter((client) => client.format === "yaml");

/** One client, one scope, one document known to hold somebody else's server. */
interface Case {
  readonly id: string;
  readonly scope: Scope;
  readonly client: McpClient;
  readonly fixture: Fixture;
}

const CASES: readonly Case[] = YAML_CLIENTS.flatMap((client) =>
  scopesOf(client).flatMap((scope) => {
    const fixture = FIXTURES[client.id]?.[scope];
    return fixture === undefined ? [] : [{ id: client.id, scope, client, fixture }];
  }),
);

/** Each client's file with everything in it but the servers — what an append has to land in. */
const WITHOUT_ROOT_KEY: Readonly<Record<string, string>> = {
  goose: "GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: claude-opus-5\n",
  continue: "name: my-config\nversion: 0.0.1\nschema: v1\n",
};

/** A second address, so `updated` is observable without spelling the real one twice. */
const ELSEWHERE = "https://example.invalid/mcp";

function merged(result: MergeResult): Merged {
  expect(result.state, result.state === "refused" ? result.reason : "").toBe("merged");
  return result as Merged;
}

function removed(result: RemoveResult): Removed {
  expect(result.state, result.state === "refused" ? result.reason : "").toBe("merged");
  return result as Removed;
}

/** Every shape the editor refuses, built from the row so both containers get the same list. */
function refusals(client: McpClient): ReadonlyArray<readonly [string, string]> {
  const key = client.rootKey;
  const wrongShape = client.container === "list" ? `${key}:\n  other: 1\n` : `${key}:\n  - name: other\n`;
  return [
    ["a flow mapping stands where a block should", `${key}: {}\n`],
    ["a flow sequence stands where a block should", `${key}: []\n`],
    ["the key carries an inline value", `${key}: null\n`],
    ["the key is declared twice at column 0", `${key}:\n  first: 1\n${key}:\n  second: 2\n`],
    ["the block is indented with a tab", `${key}:\n\tfirst: 1\n`],
    ["the block declares an anchor", `${key}:\n  first: &base\n    type: http\n`],
    ["the block uses an alias", `${key}:\n  first: *base\n`],
    ["the block uses a merge key", `${key}:\n  first:\n    <<: *base\n`],
    // A genuine split: content, then a separator, then more. A `---` before any content opens the one
    // document the file holds and is accepted — see the test below.
    ["the file holds a second document", `${key}:\n  first: 1\n---\nother: 2\n`],
    ["the block holds a line the container cannot hold", wrongShape],
    ["the entry is declared twice", twice(client)],
  ];
}

/** A block that names `pithy` twice — legal to write, impossible to edit without choosing one. */
function twice(client: McpClient): string {
  const one = yamlWriter.snippet(client);
  const body = one.split("\n").slice(1).join("\n");
  return one + body;
}

describe("the YAML writer serves both of the registry's YAML rows", () => {
  test("it is asked to write for exactly the clients declared as YAML", () => {
    expect(YAML_CLIENTS.map((client) => client.id)).toEqual(["goose", "continue"]);
  });

  test("the corpus covers every scope those clients declare", () => {
    expect(CASES.map((one) => `${one.id} ${one.scope}`)).toEqual(["goose user", "continue project", "continue user"]);
  });

  test("a document with no root key is on hand for each of them", () => {
    expect(Object.keys(WITHOUT_ROOT_KEY).sort()).toEqual(YAML_CLIENTS.map((client) => client.id).sort());
  });
});

describe("the snippet is what a missing file is written as", () => {
  test.each(YAML_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: merging into a file that does not exist returns exactly the snippet",
    (_id, client: McpClient) => {
      const result = merged(yamlWriter.merge(null, client));
      expect(result.outcome).toBe("added");
      expect(result.document).toBe(yamlWriter.snippet(client));
    },
  );

  test.each(YAML_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: a preamble is placed ahead of that same snippet, unchanged",
    (_id, client: McpClient) => {
      const preamble = client.preamble ?? "name: stand-in\nversion: 0.0.1\nschema: v1\n";
      const result = merged(yamlWriter.merge(null, client, preamble));
      expect(result.document).toBe(preamble + yamlWriter.snippet(client));
    },
  );

  test.each(YAML_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: the snippet declares the root key, the entry and one trailing newline",
    (_id, client: McpClient) => {
      const snippet = yamlWriter.snippet(client);
      expect(snippet.startsWith(`${client.rootKey}:\n`)).toBe(true);
      expect(snippet).toContain(DOCS_MCP_NAME);
      expect(snippet).toContain(DOCS_MCP_URL);
      expect(snippet).toMatch(/[^\n]\n$/);
    },
  );

  test("a scalar is quoted only where a plain one would read back as something else", () => {
    const goose = MCP_CLIENTS.find((client) => client.id === "goose") as McpClient;
    const snippet = yamlWriter.snippet(goose);
    // The URL holds a colon, so it is quoted — which is how Goose's own documentation writes it.
    expect(snippet).toContain(`uri: "${DOCS_MCP_URL}"`);
    // A boolean and an integer are the values YAML reads back as themselves. Quoting them would make
    // them strings, and Goose validates the types.
    expect(snippet).toContain("enabled: true");
    expect(snippet).toContain("timeout: 300");
    expect(snippet).toContain("type: streamable_http");
  });

  test("a sequence entry carries its own name on the item line", () => {
    const client = MCP_CLIENTS.find((one) => one.id === "continue") as McpClient;
    expect(yamlWriter.snippet(client)).toContain(`  - name: ${DOCS_MCP_NAME}`);
  });
});

describe("merging into a real document leaves the rest of it alone", () => {
  test.each(CASES.map((one) => [`${one.id} ${one.scope}`, one] as const))(
    "%s: the entry is added and every byte the adopter wrote survives",
    (_label, one: Case) => {
      const result = merged(yamlWriter.merge(one.fixture.document, one.client));
      expect(result.outcome).toBe("added");
      expect(result.document).toContain(DOCS_MCP_URL);
      for (const slice of one.fixture.survives) expect(result.document).toContain(slice);
      expect(result.document).toContain(one.fixture.neighbor);
      expect(result.document).toMatch(/[^\n]\n$/);
    },
  );

  test.each(CASES.map((one) => [`${one.id} ${one.scope}`, one] as const))(
    "%s: a second merge reports unchanged and returns the same bytes",
    (_label, one: Case) => {
      const first = merged(yamlWriter.merge(one.fixture.document, one.client));
      const second = merged(yamlWriter.merge(first.document, one.client));
      expect(second.outcome).toBe("unchanged");
      expect(second.document).toBe(first.document);
    },
  );

  test.each(CASES.map((one) => [`${one.id} ${one.scope}`, one] as const))(
    "%s: an entry pointing elsewhere is corrected rather than added",
    (_label, one: Case) => {
      const stale = merged(yamlWriter.merge(one.fixture.document, one.client)).document.replace(
        DOCS_MCP_URL,
        ELSEWHERE,
      );
      const result = merged(yamlWriter.merge(stale, one.client));
      expect(result.outcome).toBe("updated");
      expect(result.document).toContain(DOCS_MCP_URL);
      expect(result.document).not.toContain(ELSEWHERE);
      for (const slice of one.fixture.survives) expect(result.document).toContain(slice);
    },
  );

  test.each(CASES.map((one) => [`${one.id} ${one.scope}`, one] as const))(
    "%s: reading says nothing before the write and reads the address back after it",
    (_label, one: Case) => {
      const before = yamlWriter.read(one.fixture.document, one.client);
      expect(before).toEqual({ state: "read", entry: null });
      const after = yamlWriter.read(merged(yamlWriter.merge(one.fixture.document, one.client)).document, one.client);
      expect(after).toEqual({ state: "read", entry: { url: DOCS_MCP_URL, current: true } });
    },
  );

  test.each(CASES.map((one) => [`${one.id} ${one.scope}`, one] as const))(
    "%s: an entry pointing elsewhere reads as not current, at the address it names",
    (_label, one: Case) => {
      const stale = merged(yamlWriter.merge(one.fixture.document, one.client)).document.replace(
        DOCS_MCP_URL,
        ELSEWHERE,
      );
      expect(yamlWriter.read(stale, one.client)).toEqual({ state: "read", entry: { url: ELSEWHERE, current: false } });
    },
  );
});

describe("removal takes the entry and nothing beside it", () => {
  test.each(CASES.map((one) => [`${one.id} ${one.scope}`, one] as const))(
    "%s: removing what was merged restores the document byte for byte",
    (_label, one: Case) => {
      const written = merged(yamlWriter.merge(one.fixture.document, one.client)).document;
      const result = removed(yamlWriter.remove(written, one.client));
      expect(result.outcome).toBe("removed");
      expect(result.document).not.toContain(DOCS_MCP_URL);
      for (const slice of one.fixture.survives) expect(result.document).toContain(slice);
      expect(result.document).toBe(one.fixture.document);
    },
  );

  test.each(CASES.map((one) => [`${one.id} ${one.scope}`, one] as const))(
    "%s: removing from a document that never named us reports absent and changes nothing",
    (_label, one: Case) => {
      const result = removed(yamlWriter.remove(one.fixture.document, one.client));
      expect(result.outcome).toBe("absent");
      expect(result.document).toBe(one.fixture.document);
    },
  );
});

describe("a document with no root key gains one", () => {
  test.each(YAML_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: the key and the entry are appended below what was already there",
    (_id, client: McpClient) => {
      const before = WITHOUT_ROOT_KEY[client.id] as string;
      const result = merged(yamlWriter.merge(before, client));
      expect(result.outcome).toBe("added");
      expect(result.document.startsWith(before)).toBe(true);
      expect(result.document).toContain(`${client.rootKey}:`);
      expect(yamlWriter.read(result.document, client)).toEqual({
        state: "read",
        entry: { url: DOCS_MCP_URL, current: true },
      });
      expect(merged(yamlWriter.merge(result.document, client)).outcome).toBe("unchanged");
    },
  );

  test.each(YAML_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: removing the only entry takes the key Pithy added with it",
    (_id, client: McpClient) => {
      const before = WITHOUT_ROOT_KEY[client.id] as string;
      const written = merged(yamlWriter.merge(before, client)).document;
      expect(removed(yamlWriter.remove(written, client)).document).toBe(before);
    },
  );

  test.each(YAML_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: a document that says nothing at all reads as nothing at all",
    (_id, client: McpClient) => {
      expect(yamlWriter.read(WITHOUT_ROOT_KEY[client.id] as string, client)).toEqual({ state: "read", entry: null });
    },
  );
});

describe("a document it cannot read with confidence is refused, by all three operations", () => {
  const rows = YAML_CLIENTS.flatMap((client) =>
    refusals(client).map(([label, document]) => [`${client.id}: ${label}`, client, document] as const),
  );

  test.each(rows)("%s", (_label, client: McpClient, document: string) => {
    for (const result of [
      yamlWriter.merge(document, client),
      yamlWriter.remove(document, client),
      yamlWriter.read(document, client),
    ]) {
      expect(result.state).toBe("refused");
      if (result.state !== "refused") continue;
      // One line, a sentence, and nothing of the file in it: these documents sit beside credentials.
      expect(result.reason).not.toContain("\n");
      expect(result.reason.endsWith(".")).toBe(true);
      expect(result.reason.length).toBeGreaterThan(20);
      for (const line of document.split("\n")) {
        if (line.trim().length > 0) expect(result.reason).not.toContain(line.trim());
      }
    }
  });
});

describe("a document-start marker is not a split", () => {
  test.each(YAML_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: a file opening with `---` is written, not turned away",
    (_id, client: McpClient) => {
      const document = `---\n${client.rootKey}:\n${client.container === "list" ? "  - name: other\n" : "  other:\n    enabled: true\n"}`;
      const merged = yamlWriter.merge(document, client);
      expect(merged.state).toBe("merged");
      if (merged.state !== "merged") return;
      expect(merged.outcome).toBe("added");
      // The marker and the adopter's own entry both survive where they were.
      expect(merged.document.startsWith("---\n")).toBe(true);
      expect(merged.document).toContain("other");
    },
  );
});

describe("a file that exists and holds nothing", () => {
  test.each(YAML_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: an empty file is written as a file that was not there",
    (_id, client: McpClient) => {
      // `touch`, a crashed editor, a tool that made its config and never filled it. Taking the empty
      // string for a document would skip the preamble, and for Continue that produces a block file its
      // own schema rejects — reported as `added`, which is the worst way to be wrong.
      const fresh = yamlWriter.merge(null, client, client.preamble);
      for (const empty of ["", "\n", "   \n\n"]) {
        const merged = yamlWriter.merge(empty, client, client.preamble);
        expect(merged.state).toBe("merged");
        if (merged.state !== "merged") continue;
        expect(merged.outcome).toBe("added");
        expect(merged.document, `empty input ${JSON.stringify(empty)}`).toBe(
          fresh.state === "merged" ? fresh.document : "",
        );
      }
    },
  );

  test("continue's block metadata is in what an empty file becomes", () => {
    const client = clientById("continue") as McpClient;
    const merged = yamlWriter.merge("", client, client.preamble);
    expect(merged.state).toBe("merged");
    if (merged.state !== "merged") return;
    for (const key of ["name:", "version:", "schema:"]) expect(merged.document).toContain(key);
  });
});

describe("a comment at column zero inside the block", () => {
  // It reads as the end of the block to anything scanning for indentation, and that is a corruption:
  // the entry below it is never found, a second one is written above it, and the adopter's config comes
  // back with a duplicate mapping key that their tool refuses to load — reported as `added`.
  test("goose: the entry below it is found, not written a second time", () => {
    const client = clientById("goose") as McpClient;
    const entry =
      '  pithy:\n    type: streamable_http\n    name: pithy\n    enabled: true\n    uri: "https://pithy.sh/mcp"\n    timeout: 300\n';
    const document = `extensions:\n  developer:\n    enabled: true\n# a note at column zero\n${entry}`;
    const merged = yamlWriter.merge(document, client);
    expect(merged.state).toBe("merged");
    if (merged.state !== "merged") return;
    expect(merged.outcome).toBe("unchanged");
    expect(merged.document).toBe(document);
    expect(merged.document.match(/^\s*pithy:/gm)).toHaveLength(1);
  });

  test("continue: the item below it is found, not written a second time", () => {
    const client = clientById("continue") as McpClient;
    const document = `mcpServers:\n  - name: other\n    type: stdio\n# a note at column zero\n  - name: pithy\n    type: streamable-http\n    url: "https://pithy.sh/mcp"\n`;
    const merged = yamlWriter.merge(document, client);
    expect(merged.state).toBe("merged");
    if (merged.state !== "merged") return;
    expect(merged.outcome).toBe("unchanged");
    expect(merged.document.match(/name: pithy/g)).toHaveLength(1);
    expect(merged.document).toContain("# a note at column zero");
  });

  test("a comment keeps its place when the entry beside it is rewritten", () => {
    const client = clientById("goose") as McpClient;
    const document = `extensions:\n  developer:\n    enabled: true\n# a note at column zero\n  pithy:\n    type: streamable_http\n    name: pithy\n    enabled: true\n    uri: "https://elsewhere.example/mcp"\n    timeout: 300\n`;
    const merged = yamlWriter.merge(document, client);
    expect(merged.state).toBe("merged");
    if (merged.state !== "merged") return;
    expect(merged.outcome).toBe("updated");
    expect(merged.document).toContain("# a note at column zero");
    expect(merged.document).toContain("  developer:");
    expect(merged.document).toContain(DOCS_MCP_URL);
    expect(merged.document).not.toContain("elsewhere.example");
    expect(merged.document.match(/^\s*pithy:/gm)).toHaveLength(1);
  });
});
