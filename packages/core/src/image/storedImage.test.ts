// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  INLINE_IMAGE_TYPES,
  LONGEST_STORED_IMAGE_PREFIX,
  MAX_STORED_IMAGE_BYTES,
  MAX_STORED_IMAGE_CHARS,
  STORED_IMAGE_HEADERS,
  STORED_IMAGE_TYPES,
  StoredImage,
  storedImageBytes,
  storedImageSource,
  typeOfStoredImage,
} from "./storedImage";

/** A `data:` URL of `type` whose payload is `groups` base64 groups of "AAAA". */
function dataUrl(type: string, groups = 1): string {
  return `data:${type};base64,${"AAAA".repeat(groups)}`;
}

describe("what may be stored", () => {
  test("accepts every type on the allowlist", () => {
    for (const type of STORED_IMAGE_TYPES) {
      expect(StoredImage.safeParse(dataUrl(type)).success, type).toBe(true);
    }
  });

  test("refuses `data:text/html`, which is a `data:` URL too", () => {
    // The whole reason the pattern is an allowlist of types rather than a `startsWith("data:")`.
    expect(StoredImage.safeParse(dataUrl("text/html")).success).toBe(false);
    expect(StoredImage.safeParse("data:text/html;base64,PHNjcmlwdD4=").success).toBe(false);
  });

  test("refuses a media type that is an image but not on the allowlist", () => {
    expect(StoredImage.safeParse(dataUrl("image/gif")).success).toBe(false);
    expect(StoredImage.safeParse(dataUrl("image/avif")).success).toBe(false);
  });

  test("refuses a type that merely begins with an allowed one", () => {
    // `image/pngx` starts with `image/png`; the pattern must pin the whole type, not a prefix of it.
    expect(StoredImage.safeParse(dataUrl("image/pngx")).success).toBe(false);
    expect(StoredImage.safeParse(dataUrl("image/svg+xml-evil")).success).toBe(false);
  });

  test("refuses a payload over the ceiling", () => {
    const groups = Math.ceil(MAX_STORED_IMAGE_CHARS / 4);
    expect(StoredImage.safeParse(dataUrl("image/png", groups)).success).toBe(false);
  });

  test("refuses a remote URL, which is the shape this rule exists to keep out of the column", () => {
    expect(StoredImage.safeParse("https://avatars.example.com/ada.png").success).toBe(false);
  });

  test("is anchored at both ends, so nothing rides after the payload", () => {
    expect(StoredImage.safeParse(`${dataUrl("image/png")}"><script>`).success).toBe(false);
    expect(StoredImage.safeParse(` ${dataUrl("image/png")}`).success).toBe(false);
    expect(StoredImage.safeParse(`x${dataUrl("image/png")}`).success).toBe(false);
  });

  test("refuses charset and parameter games on the media type", () => {
    expect(StoredImage.safeParse("data:image/png;charset=utf-8;base64,AAAA").success).toBe(false);
    expect(StoredImage.safeParse("data:image/png,AAAA").success).toBe(false);
  });
});

describe("the derived byte ceiling", () => {
  test("is not the plain base64 inverse — the prefix is part of the bounded string", () => {
    // The bug that shipped once: a file sized at `chars * 3 / 4` encodes past the column.
    expect(MAX_STORED_IMAGE_BYTES).toBeLessThan((MAX_STORED_IMAGE_CHARS * 3) / 4);
  });

  test("a file at the ceiling encodes to a string the column accepts", () => {
    const encoded = encodeBytes(MAX_STORED_IMAGE_BYTES);
    const stored = `data:image/svg+xml;base64,${encoded}`;
    expect(stored.length).toBeLessThanOrEqual(MAX_STORED_IMAGE_CHARS);
    expect(StoredImage.safeParse(stored).success).toBe(true);
  });

  test("a file at the naive ceiling does not — which is what the arithmetic is for", () => {
    const naive = Math.floor((MAX_STORED_IMAGE_CHARS * 3) / 4);
    const stored = `data:image/svg+xml;base64,${encodeBytes(naive)}`;
    expect(stored.length).toBeGreaterThan(MAX_STORED_IMAGE_CHARS);
    expect(StoredImage.safeParse(stored).success).toBe(false);
  });

  test("the longest prefix is derived from the allowlist, not written down", () => {
    const longest = Math.max(...STORED_IMAGE_TYPES.map((type) => `data:${type};base64,`.length));
    expect(LONGEST_STORED_IMAGE_PREFIX).toBe(longest);
    // Pinned so that adding a longer type name is a visible change here rather than a silent one.
    expect(LONGEST_STORED_IMAGE_PREFIX).toBe("data:image/svg+xml;base64,".length);
  });
});

/** Base64 of `count` zero bytes, without using Buffer — the same arithmetic the browser does. */
function encodeBytes(count: number): string {
  const groups = Math.ceil(count / 3);
  return "A".repeat(groups * 4);
}

describe("what is served, and what never is", () => {
  const version = new Date(1_700_000_000_000);

  test("a raster is drawn from a URL on this origin, never from the stored string", () => {
    const source = storedImageSource(dataUrl("image/webp"), "/api/marks/member/u1", version);
    expect(source).toBe("/api/marks/member/u1?v=1700000000000");
    expect(source?.startsWith("data:")).toBe(false);
  });

  test("a vector is drawn inline and is never given a URL", () => {
    const svg = dataUrl("image/svg+xml");
    expect(storedImageSource(svg, "/api/marks/member/u1", version)).toBe(svg);
  });

  test("and the serving side refuses it, so the two halves cannot disagree", () => {
    // The gate, not a caution: a route asks this and 404s on null. There is no arrangement of ids and
    // versions that makes this origin return an SVG by navigation.
    expect(storedImageBytes(dataUrl("image/svg+xml"))).toBeNull();
    for (const type of INLINE_IMAGE_TYPES) {
      expect(storedImageBytes(dataUrl(type)), type).toBeNull();
    }
  });

  test("a value the allowlist does not match is neither drawn nor served", () => {
    // The second place this is true. A value that reached the column past a bug does not get served.
    expect(storedImageSource(dataUrl("text/html"), "/api/marks/member/u1", version)).toBeNull();
    expect(storedImageBytes(dataUrl("text/html"))).toBeNull();
    expect(typeOfStoredImage(dataUrl("text/html"))).toBeNull();
  });

  test("null is null on both sides", () => {
    expect(storedImageSource(null, "/api/marks/member/u1", version)).toBeNull();
    expect(storedImageBytes(null)).toBeNull();
  });

  test("undecodable base64 serves nothing rather than throwing", () => {
    expect(storedImageBytes("data:image/png;base64,A")).toBeNull();
  });

  test("decodes to the bytes it was given, with the allowlisted type and no sniffing", () => {
    // "Pithy" in base64.
    const decoded = storedImageBytes("data:image/png;base64,UGl0aHk=");
    expect(decoded?.type).toBe("image/png");
    expect(Array.from(decoded?.body ?? [])).toEqual([80, 105, 116, 104, 121]);
  });

  test("the version moves the URL, which is what makes `immutable` honest", () => {
    const stored = dataUrl("image/png");
    const before = storedImageSource(stored, "/api/marks/member/u1", new Date(1));
    const after = storedImageSource(stored, "/api/marks/member/u1", new Date(2));
    expect(before).not.toBe(after);
    expect(STORED_IMAGE_HEADERS["cache-control"]).toContain("immutable");
    expect(STORED_IMAGE_HEADERS["cache-control"]).toContain("private");
    expect(STORED_IMAGE_HEADERS["x-content-type-options"]).toBe("nosniff");
  });

  test("a Date and its ms-epoch produce the same URL", () => {
    const stored = dataUrl("image/png");
    expect(storedImageSource(stored, "/p", version)).toBe(storedImageSource(stored, "/p", version.getTime()));
  });
});
