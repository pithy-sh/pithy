// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The npm registry reads `pithy upgrade --packages` makes: one abbreviated packument per package, and — for
 * the template report alone — one tarball.
 *
 * **Its own fetch type, because the notifier's cannot do this.** `FetchLike` sends only a signal and reads
 * only `json()`. The abbreviated packument needs an `Accept` header, and a tarball is bytes. Widening
 * `FetchLike` would have put two capabilities the notifier never uses into every fake that stands in for it.
 *
 * **Both reads are a trust boundary.** A packument decides which version this command writes into an
 * adopter's `package.json`, so it is validated whole: one version that will not parse makes the document
 * unusable, never a shorter list. A failure of any kind is `null`, and the caller reports the step
 * `unavailable` rather than planning from half an answer.
 */

/** The slice of a `fetch` `Response` these reads use. The global `Response` satisfies it. */
export interface RegistryResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** The body as a stream, when there is one. A tarball is read through it, so the bound stops the read. */
  body?: ReadableStream<Uint8Array> | null;
}

/** A `fetch` that can send headers and read bytes. The real `globalThis.fetch` satisfies it. */
export type RegistryFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<RegistryResponse>;

/** How long one registry request may take. */
const TIMEOUT_MS = 10_000;
/** The largest tarball this reads. Ours are well under 1 MB; this is a bound, not a budget. */
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
/** The registry every `@pithy-sh/*` package is published to. */
const REGISTRY = "https://registry.npmjs.org";

export const PackumentVersion = z
  .object({
    version: z.string().describe("The version this entry describes, as published."),
    deprecated: z
      .string()
      .optional()
      .describe("The publisher's deprecation notice. Present means the version is never a move target."),
    dependencies: z
      .record(z.string().describe("A dependency's name."), z.string().describe("The range this version declares."))
      .optional()
      .describe("What this version depends on. Read to find the ui-react a given CLI version brings."),
    dist: z
      .object({
        tarball: z.string().describe("Where the published tarball is."),
        integrity: z.string().optional().describe("The tarball's SRI hash. Checked before a byte of it is read."),
      })
      .describe("The published artifact."),
  })
  .describe("One published version, as the abbreviated packument carries it.");
export type PackumentVersion = z.infer<typeof PackumentVersion>;

export const Packument = z
  .object({
    name: z.string().describe("The package's scoped name."),
    "dist-tags": z
      .object({
        latest: z.string().describe("The version the publisher calls ready. Nothing above it is a candidate."),
      })
      .describe("The package's tags. Only `latest` is read."),
    versions: z
      .record(z.string().describe("A published version."), PackumentVersion)
      .describe("Every published version, keyed by version."),
  })
  .describe("A package's abbreviated packument: its versions, their dependencies and tarballs, and `latest`.");
export type Packument = z.infer<typeof Packument>;

/** Options every registry read takes. */
export interface RegistryReadOptions {
  /** Injected `fetch`; defaults to the global. */
  fetch?: RegistryFetch;
  /** Request timeout in ms; defaults to 10 s. */
  timeoutMs?: number;
}

/** The abbreviated-packument URL for a scoped package. */
export function packumentUrl(name: string): string {
  return `${REGISTRY}/${name.replace("/", "%2F")}`;
}

/** Run one request under a timeout, handing the body reader the response. Any failure is `null`. */
async function request<T>(
  url: string,
  headers: Record<string, string>,
  options: RegistryReadOptions,
  read: (response: RegistryResponse) => Promise<T | null>,
): Promise<T | null> {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as RegistryFetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  timer.unref?.();
  try {
    // The body read races the same timer: a registry that answers headers and then stalls is still hung.
    const aborted = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null)));
    const response = await Promise.race([doFetch(url, { headers, signal: controller.signal }), aborted]);
    if (!response?.ok) return null;
    return await Promise.race([read(response), aborted]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A package's abbreviated packument, validated, or `null` on any failure. */
export async function fetchPackument(name: string, options: RegistryReadOptions = {}): Promise<Packument | null> {
  return request(packumentUrl(name), { Accept: "application/vnd.npm.install-v1+json" }, options, async (response) => {
    const parsed = Packument.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  });
}

/**
 * A tarball's bytes, or `null`. The URL comes out of an unauthenticated packument, so it is held to the
 * registry's own origin before any request is made — every `@pithy-sh/*` tarball is published there, and a
 * URL anywhere else is a request from the adopter's machine to a host the document chose. The body is read
 * to the bound and no further. What the bytes are is {@link readTemplateTarball}'s question, and its first
 * check is the integrity hash.
 */
export async function fetchTarball(
  url: string,
  options: RegistryReadOptions & { maxBytes?: number } = {},
): Promise<Uint8Array | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== REGISTRY || parsed.username !== "" || parsed.password !== "") return null;
  const max = options.maxBytes ?? MAX_TARBALL_BYTES;
  return request(parsed.href, {}, options, async (response) =>
    response.body ? readBounded(response.body, max) : boundedBytes(await response.arrayBuffer(), max),
  );
}

/** `bytes`, or `null` past `max`. */
function boundedBytes(buffer: ArrayBuffer, max: number): Uint8Array | null {
  return buffer.byteLength > max ? null : new Uint8Array(buffer);
}

/** A stream read whole, or `null` the moment it passes `max` — the rest is never pulled. */
async function readBounded(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
