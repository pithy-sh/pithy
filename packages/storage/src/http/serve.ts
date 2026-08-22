// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ReadableStream } from "@cloudflare/workers-types";
import type { ObjectConditions, ObjectMetadata, ObjectRange } from "../object/store";

/**
 * Turning an object read into an HTTP response — the one part of storage where bytes *do* pass
 * through the Worker, and the reason they do.
 *
 * Uploads never proxy through the Worker: the client PUTs straight to a presigned URL, so a 40 GiB
 * file costs the Worker one request and not one byte of transfer (that request presigns 640 part URLs
 * at the default part size — the saving is the bytes, not the signatures). Downloads are the opposite
 * trade, on purpose. A presigned GET
 * cannot be authorized per request (the signature is the authorization, and it is bearer-equivalent
 * once it leaves), cannot be revoked, and cannot carry a `Content-Disposition` the server chose. The
 * moment a file has an owner, a visibility, or a share that can be withdrawn, the read has to be a
 * request the Worker answers. `GET /storage/:id/url` is the escape hatch for callers who would rather
 * have the throughput than the control — it is offered, not the default.
 *
 * Given that, this module owns the parts of HTTP that make a byte-serving route correct rather than
 * merely working: `Range` (206), `If-None-Match` (304), `ETag`, `Content-Length`, `Content-Range`,
 * `Content-Disposition`, and a `Cache-Control` that follows the object's visibility.
 *
 * **Every byte served here is untrusted, and it is served from the adopter's own origin.** That is the
 * threat this module exists to contain. An authenticated user uploads the bytes *and* declares the type;
 * the adopter chooses the mount point, so the response shares an origin with every other Pithy route and
 * with the adopter's own app. There is no separate sandbox domain to fall back on, and we cannot invent
 * one on their behalf. So the server decides how the bytes present, not the uploader:
 *
 * - `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` on
 *   **every** object response — the id route, `HEAD`, and the share route all build headers here.
 * - An **active type is neutralised**: `text/html`, any `+xml` (which is where `image/svg+xml` lives),
 *   and script types are served as `application/octet-stream` with `Content-Disposition: attachment`,
 *   whatever was stored and whatever `?download=` said. SVG is the one that makes `attachment`
 *   non-negotiable rather than belt-and-braces: it is *meant* to render inline, and a CSP on this
 *   response does not travel with it when another origin loads it as an `<img>`.
 * - **`Content-Disposition` is derived, never replayed.** A stored disposition is a string the uploader
 *   chose, and honoring it would let them pin `inline` on the very content the rule above forces down.
 *
 * The cost is that this route will not host an adopter's own HTML or JavaScript assets. That is the
 * right trade: it is a store for user files, and Workers Assets or a bucket on its own domain is where
 * first-party markup belongs.
 *
 * **Ranges are resolved against the row's recorded size, not against R2's echo.** A `stored` row
 * knows the object's byte count — it was confirmed against R2 at completion — so `bytes=-500` can be
 * turned into an explicit offset and length before R2 is touched. That makes `Content-Range` exact,
 * makes an unsatisfiable range a 416 that costs no read at all, and removes any dependence on which
 * of R2's four range shapes comes back. A row with no recorded size simply serves the whole object;
 * a wrong `Content-Range` is worse than no range support.
 */

/** How a `Range` header resolved against a known object size. */
export type RangeRequest =
  /** No usable range — serve the whole object, 200. */
  | { kind: "none" }
  /** A single satisfiable byte range — serve 206. */
  | { kind: "bytes"; offset: number; length: number }
  /** A syntactically valid range that starts past the end — 416. */
  | { kind: "unsatisfiable" };

/** `bytes=<first>-<last>` / `bytes=<first>-` / `bytes=-<suffix>`, with optional whitespace. */
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

/**
 * Resolve a `Range` header against the object's recorded size.
 *
 * Multi-range requests (`bytes=0-9,20-29`) are answered with the **whole object**, which RFC 9110
 * explicitly permits: a server may ignore a range it does not wish to satisfy. Building a
 * `multipart/byteranges` body would mean buffering and re-framing every part in the Worker, which is
 * the exact cost this design is trying not to pay, for a feature essentially nothing asks for.
 */
export function parseRangeHeader(header: string | null | undefined, size: number | null): RangeRequest {
  if (!header || size === null) return { kind: "none" };
  const match = RANGE_PATTERN.exec(header.trim());
  if (!match) return { kind: "none" };

  const [, rawFirst, rawLast] = match;
  // `bytes=-N`: the last N bytes. N greater than the object is legal and means the whole object.
  if (rawFirst === "") {
    const suffix = Number(rawLast);
    if (rawLast === "" || !Number.isFinite(suffix) || suffix <= 0) return { kind: "none" };
    if (size === 0) return { kind: "unsatisfiable" };
    const length = Math.min(suffix, size);
    return { kind: "bytes", offset: size - length, length };
  }

  const offset = Number(rawFirst);
  if (!Number.isFinite(offset)) return { kind: "none" };
  // A range that starts at or past the end cannot be satisfied — that is what 416 is for.
  if (offset >= size) return { kind: "unsatisfiable" };

  // An absent or over-long `last` clamps to the final byte; both are ordinary, not errors.
  const last = rawLast === "" ? size - 1 : Math.min(Number(rawLast), size - 1);
  if (!Number.isFinite(last) || last < offset) return { kind: "none" };
  return { kind: "bytes", offset, length: last - offset + 1 };
}

/** The store-level range for a resolved request, or `undefined` for a whole-object read. */
export function toObjectRange(request: RangeRequest): ObjectRange | undefined {
  return request.kind === "bytes" ? { offset: request.offset, length: request.length } : undefined;
}

/**
 * The conditional-read preconditions a request's headers imply. Only `If-None-Match` is honored: it
 * is the one that saves a transfer, and the one every cache and browser actually sends. `If-Match`
 * guards writes, which this route does not perform.
 */
export function parseConditions(ifNoneMatch: string | null | undefined): ObjectConditions | undefined {
  if (!ifNoneMatch) return undefined;
  const value = ifNoneMatch.trim();
  // `*` matches any existing representation, so an existing object is unconditionally not modified.
  // Comparing an etag against the literal "*" would never match, so it is normalized away here.
  if (value === "*") return undefined;
  const etag = unquoteEtag(value.split(",")[0]?.trim() ?? "");
  return etag ? { etagDoesNotMatch: etag } : undefined;
}

/** Strip a weak-validator prefix and the surrounding quotes — R2 stores and compares the bare tag. */
function unquoteEtag(value: string): string {
  const withoutWeak = value.startsWith("W/") ? value.slice(2) : value;
  return withoutWeak.replace(/^"|"$/g, "");
}

/** What a serve path knows beyond the object's own metadata. */
export interface ServeOptions {
  /** The object's metadata, as `head` or `get` reported it. */
  metadata: ObjectMetadata;
  /** The logical path — its last segment becomes the download filename. */
  path: string;
  /** Whether anyone may read the object, which decides whether a shared cache may hold it. */
  visibility: "private" | "public";
  /** Serve as a download (`attachment`) rather than inline. */
  download?: boolean;
}

/** A response body plus the range it covers. */
export interface ServeBody {
  /** The bytes. `null` means a precondition failed — the 304 signal. */
  body: ReadableStream | null;
  /** The range served, or `null` for the whole object. */
  range: { offset: number; length: number } | null;
}

/**
 * Cache lifetimes. A private object is revalidated every time — its authorization can change between
 * two requests, and a cached copy would outlive a visibility change or a revoked share. A public
 * object is immutable in practice (a new upload gets a new id and a new key), so it is cacheable for
 * an hour by shared caches.
 */
const PRIVATE_CACHE_CONTROL = "private, no-cache, must-revalidate";
const PUBLIC_CACHE_CONTROL = "public, max-age=3600";

/** What an object is served as when its stored type is not one a browser may be trusted with. */
const NEUTRAL_CONTENT_TYPE = "application/octet-stream";

/**
 * The policy every object response carries. `default-src 'none'` means a document made out of these
 * bytes can load nothing and reach nothing; `sandbox` (with no allow-list) drops it into an opaque
 * origin, so even if a browser were talked into rendering it, it is not the adopter's origin any more.
 */
const OBJECT_CSP = "default-src 'none'; sandbox";

/**
 * Types a browser will execute, or render as a document that can execute. Served neutralised.
 *
 * The `+xml` suffix rule is what carries `image/svg+xml`, `application/xhtml+xml` and every structured
 * XML type an adopter has not thought of; the set holds the ones with no suffix to key on. Script types
 * are here because `nosniff` protects a *document* from being re-typed, not a correctly-typed script
 * from being pulled in by a `<script src>` on some other page.
 */
const ACTIVE_CONTENT_TYPES = new Set([
  "text/html",
  "text/xml",
  "text/xsl",
  "text/javascript",
  "text/ecmascript",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
]);

/** The bare type/subtype, lowercased — `Text/HTML; charset=utf-8` is `text/html` for this decision. */
function contentTypeEssence(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

/** Whether a stored type is one the server refuses to serve as itself. */
function isActiveContentType(value: string): boolean {
  const essence = contentTypeEssence(value);
  return ACTIVE_CONTENT_TYPES.has(essence) || essence.endsWith("+xml");
}

/** The type to send, and whether that decision also forces a download. */
function resolveContentType(metadata: ObjectMetadata): { contentType: string; forceAttachment: boolean } {
  const stored = metadata.contentType;
  if (!stored) return { contentType: NEUTRAL_CONTENT_TYPE, forceAttachment: false };
  if (isActiveContentType(stored)) return { contentType: NEUTRAL_CONTENT_TYPE, forceAttachment: true };
  return { contentType: stored, forceAttachment: false };
}

/** The headers every object response carries, regardless of status. */
function baseHeaders(options: ServeOptions): Headers {
  const { contentType, forceAttachment } = resolveContentType(options.metadata);
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  // The two headers that make an unexpected byte stream harmless. Set here rather than at each route,
  // because `GET /storage/:id`, `HEAD`, and `GET /s/:token` all come through this one builder.
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", OBJECT_CSP);
  // Quoted, because an `ETag` header value is a quoted-string by grammar and an unquoted one is
  // silently ignored by some caches — which turns every conditional request into a full transfer.
  headers.set("ETag", `"${options.metadata.etag}"`);
  headers.set("Cache-Control", options.visibility === "public" ? PUBLIC_CACHE_CONTROL : PRIVATE_CACHE_CONTROL);
  // Advertised on every response so a client knows a retry may resume rather than restart.
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Disposition", contentDisposition(options, forceAttachment));
  return headers;
}

/**
 * The `Content-Disposition` value, always built from the logical path's last segment. The stored
 * disposition is deliberately ignored: the uploader wrote it, so honoring it would hand them back the
 * `inline` this module just took away — and it would replay an unsanitised string into a response
 * header. The server decides how its own origin presents bytes.
 *
 * Both forms of the filename are emitted — a quote-stripped ASCII `filename` for old clients and an
 * RFC 5987 `filename*` for everything since — because a UTF-8 name in the bare parameter is what
 * makes a browser save `q3.pdf` as `q3.pdf.txt` or worse. Quotes and backslashes are dropped rather
 * than escaped: a filename is not worth a header-injection surface.
 */
function contentDisposition(options: ServeOptions, forceAttachment: boolean): string {
  const type = forceAttachment || options.download ? "attachment" : "inline";
  const segments = options.path.split("/");
  const raw = segments[segments.length - 1] ?? "download";
  const ascii = raw.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const name = ascii.length > 0 ? ascii : "download";
  return `${type}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

/**
 * Build the response for an object read: 304 when a precondition failed, 206 when a range was served,
 * 200 otherwise.
 *
 * `Content-Length` is the *served* byte count, so a ranged response reports the range's length while
 * `Content-Range` reports the whole object's size. Getting that pair backwards is the classic way a
 * range implementation appears to work until a client tries to resume.
 */
export function serveObject(options: ServeOptions & ServeBody): Response {
  const headers = baseHeaders(options);

  if (options.body === null) {
    // 304 carries validators and cache directives and nothing else — no body, and no Content-Length,
    // because the length of a body that is not being sent is not information. The security headers do
    // stay: a 304 updates the cached response's headers, and dropping them there would let a cache
    // hand back the stored copy without them.
    headers.delete("Content-Type");
    headers.delete("Content-Disposition");
    return new Response(null, { status: 304, headers });
  }

  if (options.range) {
    const { offset, length } = options.range;
    headers.set("Content-Length", String(length));
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${options.metadata.size}`);
    return new Response(options.body as unknown as globalThis.ReadableStream, { status: 206, headers });
  }

  headers.set("Content-Length", String(options.metadata.size));
  return new Response(options.body as unknown as globalThis.ReadableStream, { status: 200, headers });
}

/**
 * The `HEAD` response: exactly the headers a `GET` would carry, with no body. Same builder as the
 * 200 path, so the two cannot describe the same object differently — which is the only thing that
 * makes a `HEAD` worth issuing.
 */
export function serveMetadata(options: ServeOptions): Response {
  const headers = baseHeaders(options);
  headers.set("Content-Length", String(options.metadata.size));
  return new Response(null, { status: 200, headers });
}

/** The 416 response. `Content-Range: bytes * /size` tells the client what range would have been valid. */
export function rangeNotSatisfiable(size: number): Response {
  return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
}
