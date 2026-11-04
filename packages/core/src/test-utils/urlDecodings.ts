// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **Every way a reader of a log line could decode a URL, for the gate that holds an address out of one.**
 *
 * A URL is written to Cloudflare's request logs, Workers observability, `wrangler tail`, a mail scanner and any
 * proxy in between, so what counts is not what the URL says but what anyone holding it can recover. A signed token
 * hides nothing: its payload is base64url and decodes on sight. So the gate decodes the way such a reader would:
 * the URL raw, URL-decoded until it stops changing (with `+` as a space and without), with JSON, JavaScript and hex
 * escapes opened, and every segment between separators as base64 and base64url, at all four alignments, since a
 * decodable run need not start a segment on a four-character boundary.
 *
 * It is the gate's own reach, so a new encoding a producer could hide an address behind belongs here, not at a call
 * site.
 */

/** The separators a URL is split on before each piece is decoded: path, query, fragment and token delimiters. */
const SEPARATORS = /[/?&=#.:;,+~!$'()*[\]@%\s]+/;

/** `text` with JSON and JavaScript escapes (`\\u0040`, `\\x40`) and hex runs (`616461`) opened, where it holds any. */
function escapeDecoded(text: string): string[] {
  const out: string[] = [];
  const unescaped = text.replace(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (_, u: string, x: string) =>
    String.fromCharCode(Number.parseInt(u ?? x, 16)),
  );
  if (unescaped !== text) out.push(unescaped);
  for (const run of text.match(/(?:[0-9a-fA-F]{2}){4,}/g) ?? []) {
    out.push(String.fromCharCode(...(run.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16))));
  }
  return out;
}

/**
 * `value` URL-decoded until it stops changing, both ways a reader could: with `+` as a space, as a form decodes a
 * query, and with `+` kept, as a path segment is decoded. A malformed escape ends that branch rather than throwing.
 */
function urlDecoded(value: string): string[] {
  const out = new Set([value]);
  for (const plusIsSpace of [true, false]) {
    let current = value;
    for (let round = 0; round < 4; round += 1) {
      let next: string;
      try {
        next = decodeURIComponent(plusIsSpace ? current.replace(/\+/g, " ") : current);
      } catch {
        break;
      }
      if (next === current) break;
      out.add(next);
      current = next;
    }
  }
  for (const text of [...out]) for (const opened of escapeDecoded(text)) out.add(opened);
  return [...out];
}

/** The text one base64 or base64url run decodes to, as Latin-1 and as UTF-8, or nothing when it does not decode. */
function base64Texts(run: string): string[] {
  const standard = run
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/[^A-Za-z0-9+/]/g, "");
  const out: string[] = [];
  for (let offset = 0; offset < 4; offset += 1) {
    const aligned = standard.slice(offset);
    const trimmed = aligned.slice(0, aligned.length - (aligned.length % 4 === 1 ? 1 : 0));
    if (trimmed.length < 4) continue;
    const padded = trimmed + "=".repeat((4 - (trimmed.length % 4)) % 4);
    let binary: string;
    try {
      binary = atob(padded);
    } catch {
      continue;
    }
    out.push(binary);
    out.push(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
  }
  return out;
}

/**
 * Every decoding of `url` a log reader could reach: the URL raw, URL-decoded, and each separator-delimited segment,
 * and each pair of adjacent segments, decoded as base64 and base64url. Two levels deep, so a base64 payload that
 * itself holds a base64 field is opened too.
 */
export function urlDecodings(url: string): string[] {
  const seen = new Set<string>();
  const frontier = urlDecoded(url);
  for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const text of frontier) {
      if (seen.has(text)) continue;
      seen.add(text);
      const segments = text.split(SEPARATORS).filter((segment) => segment.length > 0);
      const runs = [...segments, ...segments.slice(1).map((segment, i) => `${segments[i]}${segment}`), text];
      for (const run of runs) {
        for (const decoded of base64Texts(run)) {
          for (const variant of urlDecoded(decoded)) if (!seen.has(variant)) next.push(variant);
        }
      }
    }
    frontier.splice(0, frontier.length, ...next);
  }
  for (const text of frontier) seen.add(text);
  return [...seen];
}

/**
 * The decodings of `url` that hold `address`, compared case-insensitively — an address is one address whatever
 * its case. Empty is the pass. The gate asserts on this rather than a boolean so a failure names what was found.
 */
export function decodingsHolding(url: string, address: string): string[] {
  const needle = address.toLowerCase();
  return urlDecodings(url).filter((text) => text.toLowerCase().includes(needle));
}
