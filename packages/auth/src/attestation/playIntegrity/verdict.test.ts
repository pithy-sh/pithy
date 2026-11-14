// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { base64UrlEncode } from "@pithy-sh/core/src/controlPlane/token/base64url";
import { describe, expect, test } from "vitest";
import { judgeIntegrityVerdict, PLAY_INTEGRITY_MAX_AGE_SECONDS, PLAY_INTEGRITY_MAX_SKEW_SECONDS } from "./verdict";

const NOW = new Date("2026-11-13T12:00:00Z");
const BINDING = new Uint8Array(32).fill(7);
const PACKAGE = "com.example.app";

/** A decoded standard-request payload that passes every check. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestDetails: {
      requestPackageName: PACKAGE,
      requestHash: base64UrlEncode(BINDING),
      timestampMillis: String(NOW.getTime() - 2_000),
    },
    appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: PACKAGE, versionCode: "42" },
    deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
    accountDetails: { appLicensingVerdict: "LICENSED" },
    ...overrides,
  };
}

function judge(value: unknown) {
  return judgeIntegrityVerdict(value, { binding: BINDING, packageName: PACKAGE, now: NOW });
}

function requestDetails(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...(payload().requestDetails as Record<string, unknown>), ...overrides };
}

describe("judgeIntegrityVerdict", () => {
  test("accepts a payload whose requestHash is the binding's base64url and whose verdicts pass", () => {
    expect(judge(payload())).toEqual({ ok: true });
  });

  test("accepts a classic request whose nonce carries the binding, padded or not", () => {
    const { requestHash: _, ...classic } = requestDetails({});
    expect(judge(payload({ requestDetails: { ...classic, nonce: base64UrlEncode(BINDING) } }))).toEqual({ ok: true });
    expect(judge(payload({ requestDetails: { ...classic, nonce: `${base64UrlEncode(BINDING)}=` } }))).toEqual({
      ok: true,
    });
  });

  test("refuses a requestHash over another challenge or body", () => {
    const other = base64UrlEncode(new Uint8Array(32).fill(8));
    expect(judge(payload({ requestDetails: requestDetails({ requestHash: other }) }))).toEqual({
      ok: false,
      reason: expect.stringMatching(/^requestHash: /),
    });
  });

  test("refuses a classic nonce over another challenge", () => {
    const { requestHash: _, ...classic } = requestDetails({});
    const verdict = judge(payload({ requestDetails: { ...classic, nonce: base64UrlEncode(new Uint8Array(32)) } }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^nonce: /) });
  });

  test("refuses a token that carries neither requestHash nor nonce", () => {
    const { requestHash: _, ...bare } = requestDetails({});
    expect(judge(payload({ requestDetails: bare }))).toEqual({
      ok: false,
      reason: expect.stringMatching(/^requestHash: /),
    });
  });

  test("refuses a token requested for another package", () => {
    const verdict = judge(payload({ requestDetails: requestDetails({ requestPackageName: "com.example.impostor" }) }));
    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringMatching(/^requestPackageName: .*com.example.impostor/),
    });
  });

  test.each(["UNRECOGNIZED_VERSION", "UNEVALUATED"])("refuses an app Play calls %s", (appRecognitionVerdict) => {
    const verdict = judge(payload({ appIntegrity: { appRecognitionVerdict } }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^appRecognitionVerdict: /) });
  });

  test("refuses a Play-recognized app whose attested package is another app's", () => {
    const verdict = judge(
      payload({ appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.example.impostor" } }),
    );
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^appIntegrity: .*com.example.impostor/) });
  });

  test("refuses a Play-recognized app that names no attested package", () => {
    const verdict = judge(payload({ appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED" } }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^appIntegrity: /) });
  });

  test("refuses a payload with no app integrity at all", () => {
    const { appIntegrity: _, ...rest } = payload();
    expect(judge(rest)).toEqual({ ok: false, reason: expect.stringMatching(/^appRecognitionVerdict: /) });
  });

  test.each([
    ["no verdict", []],
    ["basic integrity only", ["MEETS_BASIC_INTEGRITY"]],
    ["virtual integrity only", ["MEETS_VIRTUAL_INTEGRITY"]],
  ])("refuses a device with %s", (_, deviceRecognitionVerdict) => {
    const verdict = judge(payload({ deviceIntegrity: { deviceRecognitionVerdict } }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^deviceIntegrity: /) });
  });

  test("refuses a payload with no device integrity field", () => {
    expect(judge(payload({ deviceIntegrity: {} }))).toEqual({
      ok: false,
      reason: expect.stringMatching(/^deviceIntegrity: /),
    });
  });

  test("accepts strong integrity, which also meets device integrity", () => {
    const verdict = judge(
      payload({ deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY", "MEETS_STRONG_INTEGRITY"] } }),
    );
    expect(verdict).toEqual({ ok: true });
  });

  test("refuses a token requested longer ago than the window", () => {
    const stale = NOW.getTime() - (PLAY_INTEGRITY_MAX_AGE_SECONDS + 1) * 1000;
    const verdict = judge(payload({ requestDetails: requestDetails({ timestampMillis: String(stale) }) }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^timestamp: /) });
  });

  test("accepts a token at the edge of the window", () => {
    const edge = NOW.getTime() - PLAY_INTEGRITY_MAX_AGE_SECONDS * 1000;
    expect(judge(payload({ requestDetails: requestDetails({ timestampMillis: String(edge) }) }))).toEqual({
      ok: true,
    });
  });

  test("refuses a token stamped further in the future than clock skew explains", () => {
    const ahead = NOW.getTime() + (PLAY_INTEGRITY_MAX_SKEW_SECONDS + 1) * 1000;
    const verdict = judge(payload({ requestDetails: requestDetails({ timestampMillis: String(ahead) }) }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^timestamp: /) });
  });

  test("refuses a timestamp that is not a number", () => {
    const verdict = judge(payload({ requestDetails: requestDetails({ timestampMillis: "soon" }) }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^timestamp: /) });
  });

  test("refuses a payload with no request details, naming the shape", () => {
    expect(judge({})).toEqual({ ok: false, reason: expect.stringMatching(/^format: /) });
    expect(judge("nope")).toEqual({ ok: false, reason: expect.stringMatching(/^format: /) });
  });
});
