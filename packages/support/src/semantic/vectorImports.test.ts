// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { MAX_TOPK_WITHOUT_PAYLOAD } from "@pithy-sh/vector/src/index/limits";
import { describe, expect, test } from "vitest";
import { SEMANTIC_TOP_K } from "./query";

/**
 * **Support reaches `@pithy-sh/vector` through its public modules, and only these.** Support owns its
 * message index and composes no `vector()`, so what it borrows is the embedding call, the index calls, the
 * provisioning shape and the reprocess orchestration — with the `DocumentStore` seam, the document type and the
 * index config as the types those take. A new import from anywhere else in `vector` is a decision, made here.
 */

const ALLOWED = new Set([
  "@pithy-sh/vector/src/embed/embed",
  "@pithy-sh/vector/src/index/index",
  "@pithy-sh/vector/src/provision/provisionVector",
  "@pithy-sh/vector/src/workflows/reprocess",
  "@pithy-sh/vector/src/data/documents",
  "@pithy-sh/vector/src/data/document",
  "@pithy-sh/vector/src/config/config",
]);

const SRC = join(import.meta.dirname, "..");

/** Every shipped module under `src/` — no tests, no test helpers. */
const shipped = (): string[] =>
  readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.includes(".test.") && !path.startsWith("test-utils"))
    .map((path) => join(SRC, path));

describe("support's imports of @pithy-sh/vector", () => {
  test("are the public modules the issue names, and nothing else", () => {
    const found = new Map<string, string[]>();
    for (const file of shipped()) {
      for (const match of readFileSync(file, "utf8").matchAll(/from "(@pithy-sh\/vector\/[^"]+)"/g)) {
        const specifier = match[1] as string;
        found.set(specifier, [...(found.get(specifier) ?? []), relative(SRC, file)]);
      }
    }
    const outside = [...found.keys()].filter((specifier) => !ALLOWED.has(specifier));
    expect(outside, JSON.stringify(Object.fromEntries(found))).toEqual([]);
    // Anti-vacuity: the three the semantic path cannot work without are reached.
    for (const needed of ["embed/embed", "index/index", "provision/provisionVector"]) {
      expect(found.has(`@pithy-sh/vector/src/${needed}`), needed).toBe(true);
    }
  });

  test("the semantic query asks for Vectorize's payload-free ceiling", () => {
    expect(SEMANTIC_TOP_K).toBe(MAX_TOPK_WITHOUT_PAYLOAD);
  });
});
