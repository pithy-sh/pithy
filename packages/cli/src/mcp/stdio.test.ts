// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  clientById,
  DOCS_MCP_NAME,
  DOCS_MCP_URL,
  entryNameOf,
  MCP_CLIENTS,
  type McpClient,
  stdioClient,
} from "./clients";
import { writerFor } from "./connect";

/** The control-plane server's entry for one connection — the alias and the command, nothing else (#723). */
const server = (name: string) => ({ name, command: "pithy", args: ["mcp", "serve", "--connection", name] });

describe("a stdio server's entry", () => {
  test.each(MCP_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: names the connection and the command, and carries no credential",
    (_id, client) => {
      const row = stdioClient(client, server("pithy-acme-prod"));
      const merged = writerFor(row).merge(null, row, row.preamble);
      expect(merged.state).toBe("merged");
      const document = merged.state === "merged" ? merged.document : "";
      expect(document).toContain("pithy-acme-prod");
      expect(document).toContain("serve");
      // Every shape of secret-passing an MCP entry supports: none belongs in it.
      for (const key of ["env", "headers", "Authorization", "token", "jwk", "PITHY_"])
        expect(document).not.toContain(key);
      expect(entryNameOf(row)).toBe("pithy-acme-prod");
    },
  );

  test("two environments of one project are two entries in one file, beside the docs server", () => {
    const docs = clientById("claude-code") as McpClient;
    const prod = stdioClient(docs, server("pithy-acme-prod"));
    const staging = stdioClient(docs, server("pithy-acme-staging"));
    const writer = writerFor(docs);
    let document =
      writer.merge(null, docs).state === "merged" ? (writer.merge(null, docs) as { document: string }).document : "";
    for (const row of [prod, staging]) {
      const merged = writer.merge(document, row);
      if (merged.state !== "merged") throw new Error(merged.reason);
      document = merged.document;
    }
    const servers = JSON.parse(document).mcpServers as Record<string, { args?: string[] }>;
    expect(Object.keys(servers)).toEqual([DOCS_MCP_NAME, "pithy-acme-prod", "pithy-acme-staging"]);
    expect(servers["pithy-acme-staging"]?.args).toEqual(["mcp", "serve", "--connection", "pithy-acme-staging"]);

    const removed = writer.remove(document, prod);
    expect(removed.state === "merged" && Object.keys(JSON.parse(removed.document).mcpServers)).toEqual([
      DOCS_MCP_NAME,
      "pithy-acme-staging",
    ]);
  });

  test.each(MCP_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: two environments are two entries beside the docs server, merged again unchanged, removed one at a time",
    (_id, client) => {
      const prod = stdioClient(client, server("pithy-acme-prod"));
      const staging = stdioClient(client, server("pithy-acme-staging"));
      const writer = writerFor(client);
      const merge = (document: string | null, row: McpClient) => {
        const merged = writer.merge(document, row, row.preamble);
        if (merged.state !== "merged") throw new Error(merged.reason);
        return merged;
      };
      let document = merge(null, client).document;
      for (const row of [prod, staging]) {
        const merged = merge(document, row);
        // Found by the connection's own name: the docs server's entry is never the one updated.
        expect(merged.outcome).toBe("added");
        document = merged.document;
      }
      expect(document).toContain(DOCS_MCP_URL);
      expect(document).toContain("pithy-acme-prod");
      expect(document).toContain("pithy-acme-staging");

      for (const row of [client, prod, staging]) {
        const again = merge(document, row);
        expect(again.outcome).toBe("unchanged");
        expect(again.document).toBe(document);
      }

      const removed = writer.remove(document, prod);
      if (removed.state !== "merged") throw new Error("refused");
      expect(removed.outcome).toBe("removed");
      expect(removed.document).toContain(DOCS_MCP_URL);
      expect(removed.document).toContain("pithy-acme-staging");
      expect(removed.document).not.toContain("pithy-acme-prod");
      const again = writer.remove(removed.document, prod);
      expect(again.state === "merged" && again.outcome).toBe("absent");
    },
  );

  test("Goose and Continue carry the connection's own name inside the entry", () => {
    for (const id of ["goose", "continue"]) {
      const row = stdioClient(clientById(id) as McpClient, server("pithy-acme-prod"));
      expect(row.entry.name).toBe("pithy-acme-prod");
    }
  });
});
