// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_STORED_IMAGE_CHARS } from "@pithy-sh/core/src/image/storedImage";
import { describe, expect, test } from "vitest";
import { DisplayName, isInlineImage, MAX_DISPLAY_NAME_CHARS, UserImage, userImageSource } from "./profile";

const RASTER = "data:image/webp;base64,AAAA";
const VECTOR = "data:image/svg+xml;base64,AAAA";

describe("what `image` may hold", () => {
  test("a provider URL, exactly as the column has always held", () => {
    expect(UserImage.safeParse("https://lh3.googleusercontent.com/a/ACg8oc").success).toBe(true);
    expect(UserImage.safeParse("https://avatars.githubusercontent.com/u/1?v=4").success).toBe(true);
  });

  test("bytes stored under the kit's image rule", () => {
    expect(UserImage.safeParse(RASTER).success).toBe(true);
    expect(UserImage.safeParse(VECTOR).success).toBe(true);
  });

  test("refuses `data:text/html`, which is the way in this validator exists to close", () => {
    expect(UserImage.safeParse("data:text/html;base64,PHNjcmlwdD4=").success).toBe(false);
  });

  test("refuses a media type outside the allowlist", () => {
    expect(UserImage.safeParse("data:image/gif;base64,AAAA").success).toBe(false);
  });

  test("refuses a payload over the ceiling", () => {
    const over = `data:image/png;base64,${"A".repeat(MAX_STORED_IMAGE_CHARS)}`;
    expect(UserImage.safeParse(over).success).toBe(false);
  });

  test("refuses a scheme that is not http(s) — a URL's clothes on a payload", () => {
    expect(UserImage.safeParse("javascript:alert(1)").success).toBe(false);
    expect(UserImage.safeParse("file:///etc/passwd").success).toBe(false);
    expect(UserImage.safeParse("vbscript:msgbox").success).toBe(false);
  });

  test("refuses a provider URL longer than the bound", () => {
    expect(UserImage.safeParse(`https://example.com/${"a".repeat(2100)}`).success).toBe(false);
  });

  test("refuses free text, which is what the column accepted before this existed", () => {
    expect(UserImage.safeParse("not a url").success).toBe(false);
    expect(UserImage.safeParse("").success).toBe(false);
  });
});

describe("the display name", () => {
  test("is bounded on the write", () => {
    expect(DisplayName.safeParse("a".repeat(MAX_DISPLAY_NAME_CHARS)).success).toBe(true);
    expect(DisplayName.safeParse("a".repeat(MAX_DISPLAY_NAME_CHARS + 1)).success).toBe(false);
  });

  test("refuses empty, because clearing a name is not the same as naming yourself nothing", () => {
    expect(DisplayName.safeParse("").success).toBe(false);
  });
});

describe("where a face is drawn from", () => {
  const version = new Date(1_700_000_000_000);

  test("a provider link passes through — this origin has nothing to add to it", () => {
    const link = "https://avatars.githubusercontent.com/u/1?v=4";
    expect(userImageSource(link, "/auth/profile/image", version)).toBe(link);
  });

  test("a stored raster becomes a versioned URL on this origin", () => {
    expect(userImageSource(RASTER, "/auth/profile/image", version)).toBe("/auth/profile/image?v=1700000000000");
  });

  test("a stored vector stays inline and is never given a URL", () => {
    expect(userImageSource(VECTOR, "/auth/profile/image", version)).toBe(VECTOR);
    expect(isInlineImage(VECTOR)).toBe(true);
    expect(isInlineImage(RASTER)).toBe(false);
  });

  test("a value neither shape recognizes is drawn as nothing, not served", () => {
    // Second line of defense: a row that reached the column past a bug still draws initials.
    expect(userImageSource("data:text/html;base64,AAAA", "/p", version)).toBeNull();
    expect(userImageSource("javascript:alert(1)", "/p", version)).toBeNull();
    expect(userImageSource("", "/p", version)).toBeNull();
  });

  test("null is null", () => {
    expect(userImageSource(null, "/p", version)).toBeNull();
    expect(isInlineImage(null)).toBe(false);
  });

  test("the version moves the URL, which is what makes the response cacheable", () => {
    expect(userImageSource(RASTER, "/p", new Date(1))).not.toBe(userImageSource(RASTER, "/p", new Date(2)));
  });
});
