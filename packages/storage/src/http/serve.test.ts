// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ReadableStream } from "@cloudflare/workers-types";
import { describe, expect, test } from "vitest";
import type { ObjectMetadata } from "../object/store";
import {
  parseConditions,
  parseRangeHeader,
  rangeNotSatisfiable,
  serveMetadata,
  serveObject,
  toObjectRange,
} from "./serve";

/**
 * The response builder is pure, so it is tested here rather than through a Worker: every status and
 * header decision is a function of the metadata, the row, and the request headers.
 */

const metadata: ObjectMetadata = {
  key: "obj/1",
  size: 1000,
  etag: "abc123",
  contentType: "text/plain",
  uploaded: new Date("2026-01-01T00:00:00.000Z"),
};

/** A body stand-in — `serveObject` only ever hands it to `Response`. */
const body = new Blob(["x"]).stream() as unknown as ReadableStream;

describe("parseRangeHeader", () => {
  test("no header, or an unparseable one, is a whole-object read", () => {
    expect(parseRangeHeader(undefined, 1000)).toEqual({ kind: "none" });
    expect(parseRangeHeader("bytes=abc", 1000)).toEqual({ kind: "none" });
    expect(parseRangeHeader("items=0-5", 1000)).toEqual({ kind: "none" });
  });

  test("a range against an object with no recorded size is ignored rather than guessed at", () => {
    expect(parseRangeHeader("bytes=0-9", null)).toEqual({ kind: "none" });
  });

  test("a closed range resolves to an offset and a length", () => {
    expect(parseRangeHeader("bytes=0-9", 1000)).toEqual({ kind: "bytes", offset: 0, length: 10 });
    expect(parseRangeHeader("bytes=100-199", 1000)).toEqual({ kind: "bytes", offset: 100, length: 100 });
  });

  test("an open-ended range runs to the last byte", () => {
    expect(parseRangeHeader("bytes=990-", 1000)).toEqual({ kind: "bytes", offset: 990, length: 10 });
  });

  test("a range whose end runs past the object clamps rather than failing", () => {
    expect(parseRangeHeader("bytes=990-5000", 1000)).toEqual({ kind: "bytes", offset: 990, length: 10 });
  });

  test("a suffix range is resolved against the size, so Content-Range can be exact", () => {
    expect(parseRangeHeader("bytes=-100", 1000)).toEqual({ kind: "bytes", offset: 900, length: 100 });
  });

  test("a suffix longer than the object is the whole object", () => {
    expect(parseRangeHeader("bytes=-5000", 1000)).toEqual({ kind: "bytes", offset: 0, length: 1000 });
  });

  test("a range starting at or past the end is unsatisfiable — 416, with no read", () => {
    expect(parseRangeHeader("bytes=1000-", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=2000-2999", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  test("an inverted range is ignored rather than treated as an error", () => {
    expect(parseRangeHeader("bytes=500-100", 1000)).toEqual({ kind: "none" });
  });

  test("a multi-range request serves the whole object", () => {
    expect(parseRangeHeader("bytes=0-9,20-29", 1000)).toEqual({ kind: "none" });
  });

  test("toObjectRange only produces a range for a satisfiable one", () => {
    expect(toObjectRange({ kind: "bytes", offset: 4, length: 5 })).toEqual({ offset: 4, length: 5 });
    expect(toObjectRange({ kind: "none" })).toBeUndefined();
    expect(toObjectRange({ kind: "unsatisfiable" })).toBeUndefined();
  });
});

describe("parseConditions", () => {
  test("a quoted etag is unquoted, because R2 compares the bare tag", () => {
    expect(parseConditions('"abc123"')).toEqual({ etagDoesNotMatch: "abc123" });
  });

  test("a weak validator is accepted with its W/ prefix stripped", () => {
    expect(parseConditions('W/"abc123"')).toEqual({ etagDoesNotMatch: "abc123" });
  });

  test("a list takes the first entry", () => {
    expect(parseConditions('"abc123", "def456"')).toEqual({ etagDoesNotMatch: "abc123" });
  });

  test("no header, or `*`, means no precondition", () => {
    expect(parseConditions(undefined)).toBeUndefined();
    expect(parseConditions("*")).toBeUndefined();
  });
});

describe("serveObject", () => {
  test("a whole-object read is 200 with the object's length", () => {
    const response = serveObject({ metadata, body, range: null, path: "a/b.txt", visibility: "private" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("1000");
    expect(response.headers.get("Content-Range")).toBe(null);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
  });

  test("a ranged read is 206, with Content-Length the range and Content-Range the object", () => {
    const response = serveObject({
      metadata,
      body,
      range: { offset: 100, length: 50 },
      path: "a/b.txt",
      visibility: "private",
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Length")).toBe("50");
    expect(response.headers.get("Content-Range")).toBe("bytes 100-149/1000");
  });

  test("a null body is 304 — validators and cache directives only, no content headers", () => {
    const response = serveObject({ metadata, body: null, range: null, path: "a/b.txt", visibility: "private" });
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe('"abc123"');
    expect(response.headers.get("Content-Length")).toBe(null);
    expect(response.headers.get("Content-Type")).toBe(null);
    expect(response.headers.get("Content-Disposition")).toBe(null);
  });

  test("the etag is quoted — an unquoted one is ignored by caches, so every request becomes a full transfer", () => {
    const response = serveObject({ metadata, body, range: null, path: "a/b.txt", visibility: "private" });
    expect(response.headers.get("ETag")).toBe('"abc123"');
  });

  test("a private object is never cached by a shared cache; a public one is", () => {
    const isPrivate = serveObject({ metadata, body, range: null, path: "a.txt", visibility: "private" });
    expect(isPrivate.headers.get("Cache-Control")).toContain("private");
    const isPublic = serveObject({ metadata, body, range: null, path: "a.txt", visibility: "public" });
    expect(isPublic.headers.get("Cache-Control")).toContain("public");
  });

  test("the filename comes from the path's last segment, inline by default and attachment on request", () => {
    const inline = serveObject({ metadata, body, range: null, path: "invoices/2026/q3.pdf", visibility: "private" });
    expect(inline.headers.get("Content-Disposition")).toBe(
      `inline; filename="q3.pdf"; filename*=UTF-8''${encodeURIComponent("q3.pdf")}`,
    );
    const download = serveObject({
      metadata,
      body,
      range: null,
      path: "invoices/2026/q3.pdf",
      visibility: "private",
      download: true,
    });
    expect(download.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  test("a non-ASCII filename gets both an ASCII fallback and an RFC 5987 form", () => {
    const response = serveObject({ metadata, body, range: null, path: "notes/résumé.pdf", visibility: "private" });
    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain('filename="r_sum_.pdf"');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("résumé.pdf")}`);
  });

  test("quotes in a filename are dropped, not escaped — a filename is not worth a header-injection surface", () => {
    const response = serveObject({ metadata, body, range: null, path: 'a"b.txt', visibility: "private" });
    expect(response.headers.get("Content-Disposition")).toContain('filename="ab.txt"');
  });

  test("a stored Content-Disposition is ignored — the uploader does not get to pin `inline`", () => {
    const response = serveObject({
      metadata: { ...metadata, contentType: "text/html", contentDisposition: "inline" },
      body,
      range: null,
      path: "page.html",
      visibility: "public",
    });
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("Content-Disposition")).toContain('filename="page.html"');
  });

  test("a stored Content-Disposition never reaches the response, even a benign one", () => {
    const response = serveObject({
      metadata: { ...metadata, contentDisposition: 'attachment; filename="stored.bin"' },
      body,
      range: null,
      path: "derived.txt",
      visibility: "private",
    });
    expect(response.headers.get("Content-Disposition")).toContain('filename="derived.txt"');
  });

  test("an object stored without a type serves as an opaque byte stream, not as nothing", () => {
    const response = serveObject({
      metadata: { ...metadata, contentType: undefined },
      body,
      range: null,
      path: "a.bin",
      visibility: "private",
    });
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  });
});

describe("untrusted bytes are served defensively", () => {
  const serve = (contentType: string | undefined, extra: { path?: string; download?: boolean } = {}) =>
    serveObject({
      metadata: { ...metadata, contentType },
      body,
      range: null,
      path: extra.path ?? "upload.bin",
      visibility: "public",
      download: extra.download,
    });

  test("every response carries nosniff and a CSP that lets a rendered document do nothing", () => {
    const response = serve("text/plain");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  });

  test("a 304 keeps the security headers — a cache updates its stored copy from them", () => {
    const response = serveObject({ metadata, body: null, range: null, path: "a.txt", visibility: "public" });
    expect(response.status).toBe(304);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  });

  test("HTML is neutralised: octet-stream, and attachment whatever `download` said", () => {
    const response = serve("text/html", { path: "evil.html", download: false });
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  test("a charset parameter does not smuggle an active type past the check", () => {
    const response = serve("Text/HTML; charset=utf-8");
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  test("an SVG is served as an attachment — inline rendering is the whole point of the format", () => {
    const response = serve("image/svg+xml", { path: "logo.svg" });
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  test("every active type is neutralised, including the ones the `+xml` rule carries", () => {
    for (const type of [
      "text/html",
      "application/xhtml+xml",
      "image/svg+xml",
      "application/xml",
      "text/xml",
      "text/javascript",
      "application/javascript",
    ]) {
      const response = serve(type);
      expect(response.headers.get("Content-Type"), type).toBe("application/octet-stream");
      expect(response.headers.get("Content-Disposition"), type).toMatch(/^attachment;/);
    }
  });

  test("an inert type is served as itself, inline", () => {
    for (const type of ["image/png", "application/pdf", "text/plain", "video/mp4"]) {
      const response = serve(type);
      expect(response.headers.get("Content-Type"), type).toBe(type);
      expect(response.headers.get("Content-Disposition"), type).toMatch(/^inline;/);
    }
  });

  test("HEAD neutralises exactly as GET does — the two cannot describe an object differently", () => {
    const head = serveMetadata({
      metadata: { ...metadata, contentType: "image/svg+xml" },
      path: "logo.svg",
      visibility: "public",
    });
    expect(head.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(head.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(head.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("serveMetadata and 416", () => {
  test("HEAD carries exactly what GET would, with no body", async () => {
    const head = serveMetadata({ metadata, path: "a/b.txt", visibility: "public" });
    const get = serveObject({ metadata, body, range: null, path: "a/b.txt", visibility: "public" });
    expect(head.status).toBe(200);
    expect(head.body).toBe(null);
    for (const header of ["Content-Type", "Content-Length", "ETag", "Cache-Control", "Content-Disposition"]) {
      expect(head.headers.get(header)).toBe(get.headers.get(header));
    }
  });

  test("416 tells the client what range would have been valid", () => {
    const response = rangeNotSatisfiable(1000);
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */1000");
  });
});
