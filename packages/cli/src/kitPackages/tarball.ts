// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";

/**
 * Read a published `@pithy-sh/ui-react` tarball's `templates/` tree **in memory**, and refuse anything this
 * reader was not built to hold.
 *
 * The tarball is fetched from a URL a packument named, so it is untrusted until proven otherwise, and the
 * proof is ordered: the SRI hash first, over the compressed bytes, before gunzip runs at all; then a bounded
 * gunzip; then a ustar walk that refuses every header shape that can rename or redirect an entry. Nothing is
 * written to disk, so there is no path for a hostile name to escape through — the path checks are there so a
 * hostile tarball is *named* unavailable rather than compared as though it were a template tree.
 *
 * **Plain ustar is all our tarballs are**, and all this reads. `npm pack` writes 51 entries of typeflag `0`,
 * no pax headers, no long names. A pax or GNU long-name header is how a real archive carries a name this
 * walk would not see, so meeting one is a refusal of the whole read, never a skip: skipping it would read
 * the next entry under the wrong name.
 */

/** Why a tarball could not be read. One word each, for the test and the detail line. */
export type TarballRefusal =
  | "integrity"
  | "gunzip"
  | "entry-type"
  | "path"
  | "entry-size"
  | "entry-count"
  | "checksum"
  | "truncated";

/** The templates a tarball carries, keyed by path below `templates/`, or why it could not be read. */
export type TarballRead =
  | { state: "read"; files: Map<string, string> }
  | { state: "unavailable"; reason: TarballRefusal };

const BLOCK = 512;
const MAX_GUNZIP_BYTES = 10 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;
const TEMPLATES = "package/templates/";
/** Header types that carry another entry's name or attributes. Each is refused outright. */
const REFUSED_TYPES = new Set(["x", "g", "L", "K"]);

/** Whether `bytes` hash to `integrity`, which must be a `sha512-` SRI string. */
export function verifyIntegrity(bytes: Uint8Array, integrity: string): boolean {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity.trim());
  if (!match?.[1]) return false;
  const expected = Buffer.from(match[1], "base64");
  const actual = createHash("sha512").update(bytes).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A NUL-terminated ASCII field. */
function field(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

/** An octal numeric field, or `null` when it is not one (base-256 included — ours never need it). */
function octal(block: Uint8Array, offset: number, length: number): number | null {
  const text = field(block, offset, length).trim();
  if (!/^[0-7]+$/.test(text)) return null;
  return Number.parseInt(text, 8);
}

/** Whether the header's stored checksum matches its bytes, with the checksum field counted as spaces. */
function checksumOk(header: Uint8Array): boolean {
  const stored = octal(header, 148, 8);
  if (stored === null) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum === stored;
}

/** Whether a name is absolute or climbs out of where it sits. */
function unsafeName(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) return true;
  return name.split(/[/\\]/).some((segment) => segment === "..");
}

/** Walk a ustar archive, keeping `package/templates/**` regular files. */
function readUstar(tar: Uint8Array): TarballRead {
  const files = new Map<string, string>();
  let offset = 0;
  let entries = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) return { state: "read", files };
    entries += 1;
    if (entries > MAX_ENTRIES) return { state: "unavailable", reason: "entry-count" };
    if (!checksumOk(header)) return { state: "unavailable", reason: "checksum" };
    const typeflag = String.fromCharCode(header[156] ?? 0);
    if (REFUSED_TYPES.has(typeflag)) return { state: "unavailable", reason: "entry-type" };
    const size = octal(header, 124, 12);
    if (size === null || size > MAX_ENTRY_BYTES) return { state: "unavailable", reason: "entry-size" };
    const base = field(header, 0, 100);
    const prefix = field(header, 257, 6).startsWith("ustar") ? field(header, 345, 155) : "";
    const name = prefix ? `${prefix}/${base}` : base;
    if (unsafeName(name)) return { state: "unavailable", reason: "path" };
    const start = offset + BLOCK;
    if (start + size > tar.length) return { state: "unavailable", reason: "truncated" };
    const regular = typeflag === "0" || typeflag === "\0";
    if (regular && name.startsWith(TEMPLATES) && name.length > TEMPLATES.length) {
      files.set(name.slice(TEMPLATES.length), new TextDecoder().decode(tar.subarray(start, start + size)));
    }
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  // No end-of-archive block: the archive stopped mid-stream.
  return { state: "unavailable", reason: "truncated" };
}

/**
 * The templates a published tarball carries, keyed below `templates/`, or why it could not be read.
 * `integrity` is the packument's `dist.integrity`, checked over the compressed bytes before anything else.
 */
export function readTemplateTarball(tgz: Uint8Array, integrity: string): TarballRead {
  if (!verifyIntegrity(tgz, integrity)) return { state: "unavailable", reason: "integrity" };
  let tar: Uint8Array;
  try {
    tar = new Uint8Array(gunzipSync(tgz, { maxOutputLength: MAX_GUNZIP_BYTES }));
  } catch {
    return { state: "unavailable", reason: "gunzip" };
  }
  return readUstar(tar);
}
