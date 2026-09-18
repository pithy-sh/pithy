// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { readTemplateTarball, verifyIntegrity } from "./tarball";

/** One ustar entry: a 512-byte header and its content padded to a block. */
function entry(name: string, content = "", options: { typeflag?: string; prefix?: string; corrupt?: boolean } = {}) {
  const body = new TextEncoder().encode(content);
  const header = new Uint8Array(512);
  const put = (text: string, offset: number) => header.set(new TextEncoder().encode(text), offset);
  put(name, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put(options.typeflag ?? "0", 156);
  put("ustar\0", 257);
  put("00", 263);
  if (options.prefix) put(options.prefix, 345);
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  if (options.corrupt) header[0] = (header[0] ?? 0) ^ 1;
  const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
  padded.set(body);
  return [header, padded];
}

/** A gzipped tarball of `entries`, closed with the two zero blocks. */
function tgz(entries: Uint8Array[][]): Uint8Array {
  const parts = [...entries.flat(), new Uint8Array(1024)];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(gzipSync(tar));
}

const integrityOf = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** Read a tarball built here, with its own correct integrity. */
const read = (bytes: Uint8Array) => readTemplateTarball(bytes, integrityOf(bytes));

describe("verifyIntegrity", () => {
  test("sha512 only, and it must match", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(verifyIntegrity(bytes, integrityOf(bytes))).toBe(true);
    expect(verifyIntegrity(bytes, integrityOf(new TextEncoder().encode("hellp")))).toBe(false);
    expect(verifyIntegrity(bytes, `sha1-${createHash("sha1").update(bytes).digest("base64")}`)).toBe(false);
    expect(verifyIntegrity(bytes, "")).toBe(false);
  });
});

describe("readTemplateTarball", () => {
  test("keeps package/templates/** and nothing else, keyed below templates/", () => {
    const result = read(
      tgz([
        entry("package/package.json", '{"name":"@pithy-sh/ui-react"}'),
        entry("package/templates/", "", { typeflag: "5" }),
        entry("package/templates/src/router.tsx", "router\n"),
        entry("package/templates/client-env.d.ts", "env\n", { typeflag: "\0" }),
        entry("templates/src/routes/pithy/sign-in.tsx", "sign-in\n", { prefix: "package" }),
        entry("package/templates/src/link.tsx", "", { typeflag: "2" }),
        entry("package/src/templates.ts", "code"),
      ]),
    );
    expect(result.state).toBe("read");
    if (result.state !== "read") return;
    expect(Object.fromEntries(result.files)).toEqual({
      "src/router.tsx": "router\n",
      "client-env.d.ts": "env\n",
      "src/routes/pithy/sign-in.tsx": "sign-in\n",
    });
  });

  test("an integrity mismatch is refused before anything is read", () => {
    const bytes = tgz([entry("package/templates/src/router.tsx", "router\n")]);
    const other = tgz([entry("package/templates/src/router.tsx", "hostile\n")]);
    expect(readTemplateTarball(bytes, integrityOf(other))).toEqual({ state: "unavailable", reason: "integrity" });
  });

  test.each([
    ["a parent segment", entry("package/templates/../../etc/passwd", "x"), "path"],
    ["a parent segment outside templates", entry("package/../evil", "x"), "path"],
    ["an absolute name", entry("/etc/passwd", "x"), "path"],
    ["a pax header", entry("package/PaxHeader", "30 path=package/templates/a\n", { typeflag: "x" }), "entry-type"],
    ["a global pax header", entry("pax_global_header", "x", { typeflag: "g" }), "entry-type"],
    ["a GNU long name", entry("././@LongLink", "package/templates/a", { typeflag: "L" }), "entry-type"],
    ["a GNU long link", entry("././@LongLink", "package/templates/a", { typeflag: "K" }), "entry-type"],
    ["a bad checksum", entry("package/templates/a.tsx", "x", { corrupt: true }), "checksum"],
  ])("%s makes the whole read unavailable", (_label, bad, reason) => {
    const result = read(tgz([entry("package/templates/ok.tsx", "ok"), bad]));
    expect(result).toEqual({ state: "unavailable", reason });
  });

  test("an entry over 1 MB is refused", () => {
    const result = read(tgz([entry("package/templates/big.css", "a".repeat(1024 * 1024 + 1))]));
    expect(result).toEqual({ state: "unavailable", reason: "entry-size" });
  });

  test("more than 2000 entries is refused", () => {
    const many = Array.from({ length: 2001 }, (_, i) => entry(`package/templates/f${i}.txt`, ""));
    expect(read(tgz(many))).toEqual({ state: "unavailable", reason: "entry-count" });
  });

  test("gunzip output past 10 MB is refused", () => {
    // Twelve 1 MB entries: each under the entry limit, the whole over the gunzip one.
    const big = Array.from({ length: 12 }, (_, i) => entry(`package/templates/f${i}.txt`, "a".repeat(1024 * 1024)));
    expect(read(tgz(big))).toEqual({ state: "unavailable", reason: "gunzip" });
  });

  test("bytes that are not gzip are refused", () => {
    const bytes = new TextEncoder().encode("not a tarball");
    expect(read(bytes)).toEqual({ state: "unavailable", reason: "gunzip" });
  });

  test("a tar cut off mid-entry is refused", () => {
    const [header] = entry("package/templates/a.tsx", "x".repeat(600));
    const cut = new Uint8Array(gzipSync(header ?? new Uint8Array()));
    expect(read(cut)).toEqual({ state: "unavailable", reason: "truncated" });
  });
});
