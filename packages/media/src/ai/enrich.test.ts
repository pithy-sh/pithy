// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { extractMarkdown, generateImageText, type MarkdownFile, type MediaAi, transcribeAudioBytes } from "./enrich";

/** A fake AI binding: image input → a quoted description; audio input → padded text; toMarkdown → markdown. */
function fakeAi(overrides: Partial<MediaAi> = {}): MediaAi {
  return {
    run: async (_model, input) => {
      if ("audio" in input) return { text: "  hello world  " };
      return { description: '"A cat sitting on a mat."\n' };
    },
    toMarkdown: async (files: MarkdownFile[]) =>
      files.map((f) => ({ name: f.name, format: "markdown", data: "# Heading" })),
    ...overrides,
  };
}

describe("generateImageText", () => {
  test("returns cleaned alt text and caption", async () => {
    const result = await generateImageText(fakeAi(), new Uint8Array([1, 2, 3]), "@cf/vision");
    expect(result.altText).toBe("A cat sitting on a mat.");
    expect(result.caption).toBe("A cat sitting on a mat.");
  });

  test("throws media/enrichment_failed on an unexpected shape", async () => {
    const ai = fakeAi({ run: async () => ({ nope: true }) });
    await expect(generateImageText(ai, new Uint8Array(), "@cf/vision")).rejects.toMatchObject({
      payload: { code: "media/enrichment_failed" },
    });
  });
});

describe("transcribeAudioBytes", () => {
  test("returns the trimmed transcription", async () => {
    expect(await transcribeAudioBytes(fakeAi(), new Uint8Array([1]), "@cf/whisper")).toBe("hello world");
  });
});

describe("extractMarkdown", () => {
  test("joins successful conversions and sanitizes the text", async () => {
    const file: MarkdownFile = { name: "a.pdf", blob: new Blob(["x"]) };
    expect(await extractMarkdown(fakeAi(), [file])).toBe("Heading");
  });

  test("throws when a conversion errors", async () => {
    const ai = fakeAi({ toMarkdown: async () => [{ name: "a.pdf", format: "error", error: "bad pdf" }] });
    await expect(extractMarkdown(ai, [{ name: "a.pdf", blob: new Blob() }])).rejects.toMatchObject({
      payload: { code: "media/enrichment_failed" },
    });
  });

  test("throws when the binding lacks toMarkdown", async () => {
    const ai = fakeAi({ toMarkdown: undefined });
    await expect(extractMarkdown(ai, [{ name: "a.pdf", blob: new Blob() }])).rejects.toMatchObject({
      payload: { code: "media/enrichment_failed" },
    });
  });
});

/**
 * **A binding that throws is an outage, not a bad answer** (pithy-sh/pithy#348).
 *
 * `media/enrichment_failed` already covers every way a model can answer *wrongly* — an unexpected
 * shape, a conversion error, a binding with no `toMarkdown`. None of those change on a second
 * attempt. A binding that *rejects* is the other thing entirely: Workers AI was unreachable or
 * overloaded, and enrichment is fire-and-forget on finalize, so a fault the step calls terminal is
 * an asset that silently never gets its alt text.
 *
 * So the two are separated by code rather than by prose: the outage is `core/upstream_failed`, which
 * `mediaWorkflowRetry` states, and every wrong answer stays terminal.
 */
describe("a binding that cannot be reached", () => {
  const rejecting = (): MediaAi => ({
    run: async () => {
      throw new Error("Workers AI: capacity temporarily exceeded");
    },
    toMarkdown: async () => {
      throw new Error("Workers AI: capacity temporarily exceeded");
    },
  });

  test("generateImageText raises core/upstream_failed", async () => {
    await expect(generateImageText(rejecting(), new Uint8Array([1]), "@cf/vision")).rejects.toMatchObject({
      payload: { code: "core/upstream_failed" },
    });
  });

  test("transcribeAudioBytes raises core/upstream_failed", async () => {
    await expect(transcribeAudioBytes(rejecting(), new Uint8Array([1]), "@cf/whisper")).rejects.toMatchObject({
      payload: { code: "core/upstream_failed" },
    });
  });

  test("extractMarkdown raises core/upstream_failed", async () => {
    await expect(extractMarkdown(rejecting(), [{ name: "a.pdf", blob: new Blob() }])).rejects.toMatchObject({
      payload: { code: "core/upstream_failed" },
    });
  });

  test("a wrong answer is still terminal — the split is by code, not by phrasing", async () => {
    const ai = fakeAi({ run: async () => ({ nope: true }) });
    await expect(generateImageText(ai, new Uint8Array(), "@cf/vision")).rejects.toMatchObject({
      payload: { code: "media/enrichment_failed" },
    });
  });
});
