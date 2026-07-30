// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { DEFAULT_IMAGE_TO_TEXT_MODEL, DEFAULT_TRANSCRIBE_MODEL, MediaConfig } from "./config";

describe("MediaConfig", () => {
  test("applies coherent defaults with no input", () => {
    const config = MediaConfig.parse({});
    expect(config.recordStore).toBe("d1");
    expect(config.images).toEqual({ store: "cf-images", imageToText: false, model: DEFAULT_IMAGE_TO_TEXT_MODEL });
    expect(config.video).toEqual({ store: "cf-stream", transcribe: false, model: DEFAULT_TRANSCRIBE_MODEL });
    expect(config.audio).toEqual({ store: "r2", transcribe: false, model: DEFAULT_TRANSCRIBE_MODEL });
    expect(config.documents).toEqual({ store: "r2", extractText: false });
  });

  test("honors a KV record store and per-type backend choices", () => {
    const config = MediaConfig.parse({ recordStore: "kv", images: { store: "r2" } });
    expect(config.recordStore).toBe("kv");
    expect(config.images.store).toBe("r2");
    // Untouched fields keep their defaults.
    expect(config.images.imageToText).toBe(false);
  });

  test("lets an adopter override an AI model with no code change", () => {
    const config = MediaConfig.parse({ audio: { transcribe: true, model: "@cf/custom/whisper" } });
    expect(config.audio.transcribe).toBe(true);
    expect(config.audio.model).toBe("@cf/custom/whisper");
  });

  test("rejects an unknown storage backend for images", () => {
    expect(() => MediaConfig.parse({ images: { store: "gcs" } })).toThrow();
  });
});
