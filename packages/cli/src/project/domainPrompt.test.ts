// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ZoneInfo } from "@pithy-sh/cloudflare/src/zones/zonesManager";
import { describe, expect, it } from "vitest";
import { buildDomains, describeZone, domainQuestions, renderDomainsBlock, zoneForHostname } from "./domainPrompt";

const ZONES: ZoneInfo[] = [
  { id: "z1", name: "example.com", status: "active" },
  { id: "z2", name: "eu.example.com", status: "active" },
  { id: "z3", name: "acme.test", status: "pending" },
];

describe("domainQuestions", () => {
  it("asks about every managed environment and never about dev", () => {
    // `dev` has no public address by design — local answers on `http://localhost:<port>` from the pinned
    // port. Asking would invite an answer that nothing could use.
    const questions = domainQuestions("api");
    expect(questions.map((q) => q.env)).toEqual(["staging", "prod"]);
    expect(questions.every((q) => !q.message.endsWith("."))).toBe(true);
    expect(questions.find((q) => q.env === "prod")?.placeholder).toBe("api.example.com");
  });
});

describe("zoneForHostname", () => {
  it("takes the longest match, which is the only correct rule for nested zones", () => {
    expect(zoneForHostname("api.eu.example.com", ZONES)?.name).toBe("eu.example.com");
    expect(zoneForHostname("api.example.com", ZONES)?.name).toBe("example.com");
  });

  it("matches the apex itself", () => {
    expect(zoneForHostname("example.com", ZONES)?.name).toBe("example.com");
  });

  it("does not match a hostname that merely ends with the zone's characters", () => {
    expect(zoneForHostname("notexample.com", ZONES)).toBeNull();
  });

  it("returns null rather than guessing when the account owns nothing matching", () => {
    expect(zoneForHostname("api.somewhere.dev", ZONES)).toBeNull();
  });
});

describe("describeZone", () => {
  it("labels a zone that cannot carry a domain yet, rather than hiding it", () => {
    // Hiding a pending zone makes the account look like it does not have the domain at all — the more
    // confusing of the two failures.
    expect(describeZone(ZONES[0] as ZoneInfo)).toBe("example.com");
    expect(describeZone(ZONES[2] as ZoneInfo)).toBe("acme.test (pending)");
  });
});

describe("buildDomains", () => {
  it("builds a declaration from answers, keeping the zone the account confirmed", () => {
    const result = buildDomains([
      { env: "staging", hostname: "staging.api.example.com", zone: "example.com" },
      { env: "prod", hostname: "api.example.com", zone: "example.com" },
    ]);
    expect(result).toEqual({
      domains: {
        staging: { pattern: "staging.api.example.com", zone: "example.com" },
        prod: { pattern: "api.example.com", zone: "example.com" },
      },
    });
  });

  it("infers the registrable pair only when no zone was confirmed", () => {
    // The offline path. Wrong for `example.co.uk` and for an account whose zone is itself a subdomain —
    // acceptable because the value lands in `pithy.config.ts` where the adopter can see and fix it.
    expect(buildDomains([{ env: "prod", hostname: "api.example.com" }])).toEqual({
      domains: { prod: { pattern: "api.example.com", zone: "example.com" } },
    });
  });

  it("prefers a confirmed nested zone over the inference that would have been wrong", () => {
    expect(buildDomains([{ env: "prod", hostname: "api.eu.example.com", zone: "eu.example.com" }])).toEqual({
      domains: { prod: { pattern: "api.eu.example.com", zone: "eu.example.com" } },
    });
  });

  it("treats an empty answer as a skip, and all-skipped as no declaration at all", () => {
    // A project with no domains should have no `domains` key — not an empty object that reads as a
    // half-finished declaration.
    expect(
      buildDomains([
        { env: "staging", hostname: "  " },
        { env: "prod", hostname: "" },
      ]),
    ).toEqual({
      domains: undefined,
    });
    expect(
      buildDomains([
        { env: "staging", hostname: "" },
        { env: "prod", hostname: "api.example.com" },
      ]),
    ).toEqual({
      domains: { prod: { pattern: "api.example.com", zone: "example.com" } },
    });
  });

  it("refuses exactly what the config would refuse, so the failure lands on the question", () => {
    // A prompt that accepted something `WorkerDomain` rejects would move the failure from a question to
    // a stack trace at deploy.
    for (const bad of ["https://api.example.com", "api.example.com/hooks", "api.example.com:8787", "localhost"]) {
      const result = buildDomains([{ env: "prod", hostname: bad }]);
      expect("rejected" in result, `${bad} should be refused`).toBe(true);
    }
  });

  it("refuses a hostname outside the zone it names, naming both values", () => {
    const result = buildDomains([{ env: "prod", hostname: "api.example.com", zone: "other.test" }]);
    expect("rejected" in result).toBe(true);
    if ("rejected" in result) expect(result.rejected.action).toContain("other.test");
  });
});

describe("renderDomainsBlock", () => {
  it("writes a comment-documented block naming what it generates", () => {
    const block = renderDomainsBlock({
      staging: { pattern: "staging.api.example.com", zone: "example.com" },
      prod: { pattern: "api.example.com", zone: "example.com" },
    });
    expect(block).toContain("domains: {");
    expect(block).toContain('staging: { pattern: "staging.api.example.com", zone: "example.com" },');
    expect(block).toContain('prod: { pattern: "api.example.com", zone: "example.com" },');
    // The comment has to say what it drives, or an adopter edits wrangler.jsonc and wonders why it reverts.
    expect(block).toContain("vars.BASE_URL");
  });

  it("omits an environment with no domain", () => {
    const block = renderDomainsBlock({ prod: { pattern: "api.example.com", zone: "example.com" } });
    expect(block).not.toContain("staging:");
  });
});
