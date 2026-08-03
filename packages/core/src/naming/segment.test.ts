// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { assertValidEnvironment, isValidEnvironment } from "./environment";
import { isValidProjectName } from "./resource";
import { NAME_SEGMENT } from "./segment";

describe("NAME_SEGMENT", () => {
  it("accepts a lowercase, digit-carrying, single-hyphenated segment starting with a letter", () => {
    for (const segment of ["a", "acme", "acme-corp", "dev", "staging", "media-audio-transcribe", "pr-7", "dev2"]) {
      expect(NAME_SEGMENT.test(segment), segment).toBe(true);
    }
  });

  it("rejects everything a Cloudflare namespace would refuse or a composer would mangle", () => {
    // Leading digit: legal for D1, KV and R2, refused by Worker scripts, Workflows and Vectorize —
    // which is why the strictest rule is the only one worth having.
    for (const segment of ["", "1dev", "-dev", "dev-", "a--b", "Prod", "my env", "dev_1", "dev.1", "acme "]) {
      expect(NAME_SEGMENT.test(segment), segment).toBe(false);
    }
  });

  it("is stateless, so one shared instance is safe across every caller", () => {
    // A `/g` regex would carry `lastIndex` between callers and answer differently on alternate calls.
    expect(NAME_SEGMENT.global).toBe(false);
    expect(NAME_SEGMENT.test("acme")).toBe(NAME_SEGMENT.test("acme"));
  });
});

describe("the rules built on it", () => {
  it("is the shape an environment is held to", () => {
    for (const value of ["qa", "pr-7", "1dev", "Prod", "dev-"]) {
      expect(isValidEnvironment(value), value).toBe(NAME_SEGMENT.test(value));
    }
  });

  it("is the shape a project name is held to, once kebabbed", () => {
    // The project rule reads the *kebabbed* form — `Acme Corp` is a legal project and an illegal
    // segment — so the two agree on what the composer will actually emit, not on the raw string.
    for (const value of ["acme", "acme-corp", "1password-clone"]) {
      expect(isValidProjectName(value), value).toBe(NAME_SEGMENT.test(value));
    }
  });

  it("names itself in the refusal, so an operator sees the one rule", () => {
    // The error `detail` quotes `NAME_SEGMENT.source`. A second copy of the pattern would let the
    // sentence describe a rule the check no longer applies.
    let detail = "";
    try {
      assertValidEnvironment("Prod");
    } catch (error) {
      detail = (error as { payload: { detail?: string } }).payload.detail ?? "";
    }
    expect(detail).toContain(NAME_SEGMENT.source);
  });
});
