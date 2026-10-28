// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { R2Bucket } from "@cloudflare/workers-types";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { decodeBase64, EVIDENCE_PREFIX, keepEvidence, readEvidence, sha256Hex } from "./evidence";

/**
 * The evidence helpers, on real R2: base64 that is not base64 decodes to nothing, an object is written once under
 * its own hash with its media type, and a read finds it under either prefix or answers `null`.
 */

const bytes = (...values: number[]) => new Uint8Array(values);

describe("decodeBase64", () => {
  test("decodes standard base64 to its bytes", () => {
    expect(decodeBase64(btoa("\u0001\u0002ÿ"))).toEqual(bytes(1, 2, 255));
  });

  test("answers null for anything that is not base64, never an empty array", () => {
    for (const value of ["%%%", "not base64!", "a"]) expect(decodeBase64(value), value).toBeNull();
  });

  test("answers an empty array for the empty string, which the store refuses on its own", () => {
    expect(decodeBase64("")).toEqual(bytes());
  });
});

describe("keepEvidence", () => {
  test("writes once under its own hash and keeps the media type", async () => {
    const image = bytes(137, 80, 78, 71, 9, 9, 9);
    const hash = await keepEvidence(env.CONSENT_EVIDENCE, "drawn", image, "image/png");
    expect(hash).toBe(await sha256Hex(image));
    const object = await env.CONSENT_EVIDENCE.get(`${EVIDENCE_PREFIX.drawn}${hash}`);
    expect(object?.httpMetadata?.contentType).toBe("image/png");
    await object?.arrayBuffer();
  });

  test("skips the put when the object is already there", async () => {
    const puts: string[] = [];
    const stored = new Set<string>();
    const bucket = {
      head: async (key: string) => (stored.has(key) ? {} : null),
      put: async (key: string) => {
        puts.push(key);
        stored.add(key);
      },
    } as unknown as R2Bucket;
    const certificate = bytes(37, 80, 68, 70);
    const first = await keepEvidence(bucket, "certificate", certificate, "application/pdf");
    const second = await keepEvidence(bucket, "certificate", certificate, "application/pdf");
    expect(second).toBe(first);
    expect(puts).toEqual([`${EVIDENCE_PREFIX.certificate}${first}`]);
  });

  test("is refused, naming the binding, where no bucket is bound", async () => {
    const result = keepEvidence(undefined, "drawn", bytes(1), "image/png").catch((error: unknown) => error);
    const error = await result;
    expect(error instanceof PithyError ? error.payload.code : error).toBe("consent/evidence_store_missing");
  });
});

describe("readEvidence", () => {
  test("finds an object under either prefix", async () => {
    const drawn = await keepEvidence(env.CONSENT_EVIDENCE, "drawn", bytes(4, 5, 6), "image/png");
    const pdf = await keepEvidence(env.CONSENT_EVIDENCE, "certificate", bytes(7, 8, 9), "application/pdf");
    const image = await readEvidence(env.CONSENT_EVIDENCE, drawn);
    expect(new Uint8Array(image?.bytes ?? new ArrayBuffer(0))).toEqual(bytes(4, 5, 6));
    expect(image?.contentType).toBe("image/png");
    const certificate = await readEvidence(env.CONSENT_EVIDENCE, pdf);
    expect(new Uint8Array(certificate?.bytes ?? new ArrayBuffer(0))).toEqual(bytes(7, 8, 9));
    expect(certificate?.contentType).toBe("application/pdf");
  });

  test("answers null for a hash nothing holds", async () => {
    expect(await readEvidence(env.CONSENT_EVIDENCE, "0".repeat(64))).toBeNull();
  });
});
