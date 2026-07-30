// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { vector_0001_documents } from "./0001_documents";

const db = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;

async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_vector_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_vector_documents");
});

describe("vector_0001_documents", () => {
  test("up creates the corpus table and both read indexes", async () => {
    await vector_0001_documents.up(db());
    expect(await catalog()).toEqual([
      "pithy_vector_documents",
      "pithy_vector_documents_index_idx",
      "pithy_vector_documents_model_idx",
    ]);
  });

  test("the id CHECK constraint rejects an id Vectorize could not address, at the DB level", async () => {
    await vector_0001_documents.up(db());
    const id = "x".repeat(65);
    await expect(
      env.DB.prepare(
        "INSERT INTO pithy_vector_documents (id, index_name, metadata, created_at, updated_at) VALUES (?, 'docs', '{}', 0, 0)",
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  test("the id CHECK counts bytes, not characters — a 64-character multi-byte id is refused", async () => {
    await vector_0001_documents.up(db());
    // 64 characters, 128 bytes in UTF-8. `length(id)` would accept it; `length(cast(id as blob))` does not.
    await expect(
      env.DB.prepare(
        "INSERT INTO pithy_vector_documents (id, index_name, metadata, created_at, updated_at) VALUES (?, 'docs', '{}', 0, 0)",
      )
        .bind("é".repeat(64))
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  test("a 64-byte id is accepted", async () => {
    await vector_0001_documents.up(db());
    await env.DB.prepare(
      "INSERT INTO pithy_vector_documents (id, index_name, metadata, created_at, updated_at) VALUES (?, 'docs', '{}', 0, 0)",
    )
      .bind("x".repeat(64))
      .run();
    const { results } = await env.DB.prepare("SELECT id FROM pithy_vector_documents").all<{ id: string }>();
    expect(results).toHaveLength(1);
  });

  test("the primary key is (index_name, id), so one id in two indexes is two rows", async () => {
    await vector_0001_documents.up(db());
    const insert = (index: string, content: string) =>
      env.DB.prepare(
        "INSERT INTO pithy_vector_documents (id, index_name, content, metadata, created_at, updated_at) VALUES ('intro', ?, ?, '{}', 0, 0)",
      )
        .bind(index, content)
        .run();

    await insert("docs", "the docs intro");
    await insert("faqs", "the faqs intro");

    const { results } = await env.DB.prepare(
      "SELECT index_name, content FROM pithy_vector_documents WHERE id = 'intro' ORDER BY index_name",
    ).all<{ index_name: string; content: string }>();
    expect(results).toEqual([
      { index_name: "docs", content: "the docs intro" },
      { index_name: "faqs", content: "the faqs intro" },
    ]);

    // And the key still holds within one index.
    await expect(insert("docs", "a second docs intro")).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("down is the exact inverse and up is re-runnable after it", async () => {
    await vector_0001_documents.up(db());
    await vector_0001_documents.down?.(db());
    expect(await catalog()).toEqual([]);
    await vector_0001_documents.up(db());
    expect(await catalog()).toContain("pithy_vector_documents");
  });
});
