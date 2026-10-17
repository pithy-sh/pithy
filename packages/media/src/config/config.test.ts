// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  DEFAULT_IMAGE_TO_TEXT_MODEL,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  DEFAULT_TRANSCRIBE_MODEL,
  MediaConfig,
  refuseRemovedMediaOptions,
} from "./config";

describe("MediaConfig", () => {
  test("applies coherent defaults with no input", () => {
    const config = MediaConfig.parse({});
    expect(config.recordStore).toBe("d1");
    expect(config.visibility).toEqual({ default: "private", allowed: ["private", "organization", "public"] });
    expect(config.dedup).toEqual({ scope: "tenant" });
    expect(config.delivery.signedUrlTtlSeconds).toBe(DEFAULT_SIGNED_URL_TTL_SECONDS);
    expect(config.images).toEqual({ store: "cf-images", imageToText: false, model: DEFAULT_IMAGE_TO_TEXT_MODEL });
    expect(config.video).toEqual({ store: "cf-stream", transcribe: false, model: DEFAULT_TRANSCRIBE_MODEL });
    expect(config.audio).toEqual({ store: "r2", transcribe: false, model: DEFAULT_TRANSCRIBE_MODEL });
    expect(config.documents).toEqual({ store: "r2", extractText: false });
  });

  test("honors per-type backend choices", () => {
    const config = MediaConfig.parse({ images: { store: "r2" } });
    expect(config.images.store).toBe("r2");
    // Untouched fields keep their defaults.
    expect(config.images.imageToText).toBe(false);
  });

  test("accepts only the D1 record store", () => {
    expect(MediaConfig.safeParse({ recordStore: "kv" }).success).toBe(false);
  });

  test("lets an adopter override an AI model with no code change", () => {
    const config = MediaConfig.parse({ audio: { transcribe: true, model: "@cf/custom/whisper" } });
    expect(config.audio.transcribe).toBe(true);
    expect(config.audio.model).toBe("@cf/custom/whisper");
  });

  test("rejects an unknown storage backend for images", () => {
    expect(() => MediaConfig.parse({ images: { store: "gcs" } })).toThrow();
  });

  test("a visibility default outside allowed is refused at boot", () => {
    expect(MediaConfig.safeParse({ visibility: { default: "public", allowed: ["private"] } }).success).toBe(false);
  });

  test("account-wide dedup is reachable only by naming it", () => {
    expect(MediaConfig.parse({ dedup: { scope: "account" } }).dedup.scope).toBe("account");
  });

  test("a public R2 base URL is refused while a record could be anything but public", () => {
    const result = MediaConfig.safeParse({ delivery: { r2PublicBaseUrl: "https://media.example.com" } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["delivery", "r2PublicBaseUrl"]);
    expect(result.error?.issues[0]?.message).toContain('narrow visibility.allowed to ["public"]');
  });

  test("and accepted when every record is public", () => {
    const config = MediaConfig.parse({
      delivery: { r2PublicBaseUrl: "https://media.example.com" },
      visibility: { default: "public", allowed: ["public"] },
    });
    expect(config.delivery.r2PublicBaseUrl).toBe("https://media.example.com");
  });
});

describe("refuseRemovedMediaOptions", () => {
  test("a config naming the kv record store is refused with the remedy named", () => {
    let thrown: unknown;
    try {
      refuseRemovedMediaOptions({ recordStore: "kv" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ payload: { code: "validation/invalid_input" } });
    const payload = (thrown as { payload: { message: string; action: string } }).payload;
    expect(payload.message).toContain("`kv` media record store was removed");
    expect(payload.action).toContain("Remove `recordStore: 'kv'`");
    expect(payload.action).toContain("migrate each environment");
  });

  test("kvMetadata is refused too — it configured the store that is gone", () => {
    expect(() => refuseRemovedMediaOptions({ kvMetadata: ["type"] })).toThrow(/kvMetadata/);
  });

  test("the D1 store, named or not, passes", () => {
    expect(() => refuseRemovedMediaOptions({ recordStore: "d1" })).not.toThrow();
    expect(() => refuseRemovedMediaOptions({})).not.toThrow();
  });
});
