// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { resolveSitekey, TURNSTILE_TEST_KEYS, testKeyVerdict } from "./testKeys";

const sitekeys = { dev: "1x00000000000000000000AA", staging: "1x00000000000000000000AA", prod: "0x4AAAAreal" };

describe("testKeyVerdict (#731)", () => {
  test("names what each of Cloudflare's documented test sitekeys always does", () => {
    expect(testKeyVerdict(TURNSTILE_TEST_KEYS.sitekey.visiblePass)).toBe("passes");
    expect(testKeyVerdict(TURNSTILE_TEST_KEYS.sitekey.invisiblePass)).toBe("passes");
    expect(testKeyVerdict(TURNSTILE_TEST_KEYS.sitekey.visibleBlock)).toBe("blocks");
    expect(testKeyVerdict(TURNSTILE_TEST_KEYS.sitekey.invisibleBlock)).toBe("blocks");
    expect(testKeyVerdict(TURNSTILE_TEST_KEYS.sitekey.forceChallenge)).toBe("challenges");
  });

  test("the invisible always-fails key is Cloudflare's published one", () => {
    // https://developers.cloudflare.com/turnstile/troubleshooting/testing/, read 2026-10-18.
    expect(TURNSTILE_TEST_KEYS.sitekey.invisibleBlock).toBe("2x00000000000000000000BB");
  });

  test("a real widget's sitekey is not a test key", () => {
    expect(testKeyVerdict("0x4AAAAAAABkMYinukE8nzYS")).toBeNull();
  });
});

describe("resolveSitekey (#731)", () => {
  test("resolves the sitekey the config states for the environment", () => {
    expect(resolveSitekey(sitekeys, "dev", "visible")).toBe("1x00000000000000000000AA");
    expect(resolveSitekey(sitekeys, "prod", "visible")).toBe("0x4AAAAreal");
  });

  test("a feature resolves the mode's always-pass test key when the config states none (#656)", () => {
    expect(resolveSitekey(sitekeys, "feature", "visible")).toBe(TURNSTILE_TEST_KEYS.sitekey.visiblePass);
    expect(resolveSitekey(sitekeys, "feature", "invisible")).toBe(TURNSTILE_TEST_KEYS.sitekey.invisiblePass);
  });

  test("a blank key and an environment no key exists for both resolve nothing", () => {
    expect(resolveSitekey({ ...sitekeys, prod: "" }, "prod", "visible")).toBeUndefined();
    expect(resolveSitekey(sitekeys, "live", "visible")).toBeUndefined();
    expect(resolveSitekey({ ...sitekeys, feature: "" }, "feature", "visible")).toBeUndefined();
  });
});
