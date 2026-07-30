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
