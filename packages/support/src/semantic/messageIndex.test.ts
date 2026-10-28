// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { SupportConfig } from "../config/config";
import { SupportReprocessParams } from "../workflows/specs";
import {
  embeddingText,
  MAX_EMBED_CHARS,
  SUPPORT_MESSAGES_INDEX,
  supportMessageIndex,
  supportMessageIndexName,
  supportMessageIndexShape,
} from "./messageIndex";

const search = (semantic: unknown) => SupportConfig.parse({ search: { semantic } }).search;

describe("the message index", () => {
  test("is absent while search.semantic is off", () => {
    expect(supportMessageIndex(search(false))).toBeUndefined();
    expect(supportMessageIndexShape(search(false))).toBeUndefined();
  });

  test("defaults to bge-m3, 1024 components, cosine, on its own binding", () => {
    expect(supportMessageIndex(search(true))).toEqual({
      model: "@cf/baai/bge-m3",
      dimensions: 1024,
      metric: "cosine",
      binding: "SUPPORT_VECTORIZE",
    });
    expect(supportMessageIndexShape(search(true))).toEqual({ dimensions: 1024, metric: "cosine" });
  });

  test("takes the adopter's model", () => {
    expect(supportMessageIndex(search({ model: "@cf/own" }))?.model).toBe("@cf/own");
  });

  test("is named through the facade, per project and environment", () => {
    expect(supportMessageIndexName("acme", "prod")).toBe("acme-prod-support-messages");
    expect(supportMessageIndexName("acme", "staging")).not.toBe(supportMessageIndexName("globex", "staging"));
  });

  test("a feature gets its own index", () => {
    const name = supportMessageIndexName("acme", "feature", { project: "acme", issue: "94", slug: "hybrid" });
    expect(name).toContain("support-messages");
    expect(name).not.toBe(supportMessageIndexName("acme", "dev"));
  });

  test("the reprocess Workflow takes the same name the CLI reprocesses by", () => {
    expect(SupportReprocessParams.parse({ index: SUPPORT_MESSAGES_INDEX }).index).toBe(SUPPORT_MESSAGES_INDEX);
  });

  test("embeds the subject and body, bounded", () => {
    expect(embeddingText("Subject", "Body")).toBe("Subject\n\nBody");
    expect(embeddingText("s", "x".repeat(10_000))).toHaveLength(MAX_EMBED_CHARS);
  });
});
