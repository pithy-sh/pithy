// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  baseUrlFor,
  domainFor,
  type HostnameProblem,
  isPublicHostname,
  LOCAL_ORIGIN,
  originFor,
  publicHostnameProblem,
  resolveOrigin,
  WorkerDomain,
  WorkerDomains,
} from "./domains";

const DOMAINS = WorkerDomains.parse({
  staging: { pattern: "staging.api.example.com", zone: "example.com" },
  prod: { pattern: "api.example.com", zone: "example.com" },
});

describe("resolveOrigin", () => {
  test("a declared environment resolves to its own https origin", () => {
    expect(resolveOrigin("prod", DOMAINS)).toEqual({
      origin: "https://api.example.com",
      hostname: "api.example.com",
      declared: true,
    });
    expect(resolveOrigin("staging", DOMAINS)).toEqual({
      origin: "https://staging.api.example.com",
      hostname: "staging.api.example.com",
      declared: true,
    });
  });

  /**
   * The load-bearing half. The shape being replaced fell back to production's origin, which is how a
   * staging deploy mails real users magic links into production. This one goes nowhere.
   */
  test("an environment with no declared domain never reaches for another environment's", () => {
    const staging = WorkerDomains.parse({ prod: { pattern: "api.example.com", zone: "example.com" } });
    expect(resolveOrigin("staging", staging)).toEqual({
      origin: LOCAL_ORIGIN,
      hostname: "localhost",
      declared: false,
    });
    expect(originFor("staging", staging)).not.toContain("api.example.com");
  });

  test("dev is never declared, and an absent declaration is the same answer", () => {
    expect(originFor("dev", DOMAINS)).toBe(LOCAL_ORIGIN);
    expect(originFor("prod", undefined)).toBe(LOCAL_ORIGIN);
  });

  /** No port, deliberately: local's port is assigned per run, so it is the one address nobody can write down. */
  test("the local origin carries no port", () => {
    expect(LOCAL_ORIGIN).toBe("http://localhost");
  });
});

/**
 * **The invariant: no config value carries an origin that a different environment would need to be
 * different.**
 *
 * Stated over the declaration rather than as a list of the fields that got it wrong — `auth.baseURL`,
 * `email.baseUrl`, the Stripe return URLs — because that list is what goes stale, and it went stale
 * three times in one Worker. What holds instead is that every published environment's origin is derived
 * from that environment's own declaration, so two of them can never be the same string unless the
 * adopter declared the same hostname twice.
 */
describe("no two published environments share an origin", () => {
  test("every declared environment derives its own", () => {
    const origins = ["staging", "prod"].map((env) => originFor(env, DOMAINS));
    expect(new Set(origins).size).toBe(origins.length);
  });

  /**
   * The planted violation: the shape an adopter writes when they type a URL instead of deriving one.
   * A literal is the same string in every environment, which is exactly what the derived form cannot be.
   */
  test("and a hardcoded origin is the thing that breaks it", () => {
    const HARDCODED = "https://api.example.com";
    const origins = ["staging", "prod"].map(() => HARDCODED);
    expect(new Set(origins).size).not.toBe(origins.length);
  });

  /** Composed from the two halves that already existed, so a caller cannot reach a third answer. */
  test("it is domainFor and baseUrlFor, and nothing else", () => {
    for (const env of ["staging", "prod"]) {
      const domain = domainFor(DOMAINS, env);
      expect(domain).not.toBeNull();
      expect(originFor(env, DOMAINS)).toBe(baseUrlFor(domain as never));
    }
  });
});

/**
 * **A feature deployment answers on `workers.dev`, and knows it only from what provisioning stamped (#643).**
 *
 * A feature Worker's address is `https://<script>.<account subdomain>.workers.dev`. The Worker cannot look the
 * subdomain up, so provisioning derives the address and stamps it as the stanza's `BASE_URL`, and this is the
 * one reader of it. Project `replay` and Worker `board` differ on purpose: a fixture where both are `api` hides
 * the script name being composed from the wrong one.
 */
describe("a feature environment's origin", () => {
  const FEATURE_ORIGIN = "https://replay-f643-feature-address--board.acme.workers.dev";

  test("is the address provisioning stamped", () => {
    expect(resolveOrigin("feature", undefined, FEATURE_ORIGIN)).toEqual({
      origin: FEATURE_ORIGIN,
      hostname: "replay-f643-feature-address--board.acme.workers.dev",
      declared: false,
    });
  });

  test("is what originFor answers inside the deployed Worker", () => {
    expect(originFor("feature", DOMAINS, { ENVIRONMENT: "feature", BASE_URL: FEATURE_ORIGIN })).toBe(FEATURE_ORIGIN);
  });

  test("normalizes a trailing slash away", () => {
    expect(originFor("feature", undefined, { BASE_URL: `${FEATURE_ORIGIN}/` })).toBe(FEATURE_ORIGIN);
  });

  /**
   * The inherited value. A feature stanza is generated from the top level, and a hand-set top-level `BASE_URL`
   * is somebody else's origin — production's, most likely. Honoring it would mail a branch's links into prod.
   */
  test("refuses anything that is not a workers.dev https origin, and goes nowhere instead", () => {
    for (const stamped of [
      "https://app.example.com",
      "http://replay-f643-feature-address--board.acme.workers.dev",
      "https://replay-f643-feature-address--board.acme.workers.dev/path",
      "https://replay-f643-feature-address--board.acme.workers.dev:8443",
      "https://workers.dev",
      "not a url",
      "",
    ]) {
      expect(originFor("feature", undefined, { BASE_URL: stamped })).toBe(LOCAL_ORIGIN);
    }
  });

  /**
   * **A stamp whose hostname is not one (#643).** The URL parser decodes `%2e%2e` into `..`, so
   * `https://%2e%2e.acme.workers.dev` has four dot-separated parts and ends in `.workers.dev` — and is no
   * Worker's address. Every label must be a DNS label.
   */
  test("refuses a stamp whose hostname has an empty, encoded or malformed label", () => {
    for (const stamped of [
      "https://%2e%2e.acme.workers.dev",
      "https://a.%2e%2e.acme.workers.dev",
      "https://a..acme.workers.dev",
      "https://a_b.acme.workers.dev",
      "https://-a.acme.workers.dev",
      "https://a.acme.workers.dev.",
    ]) {
      expect(originFor("feature", undefined, { BASE_URL: stamped }), stamped).toBe(LOCAL_ORIGIN);
    }
  });

  test("is never read for any other environment", () => {
    for (const env of ["dev", "staging", "prod", undefined]) {
      expect(originFor(env, undefined, { BASE_URL: FEATURE_ORIGIN })).toBe(LOCAL_ORIGIN);
    }
    // And a declared domain still wins where one exists.
    expect(originFor("prod", DOMAINS, { BASE_URL: FEATURE_ORIGIN })).toBe("https://api.example.com");
  });

  test("is the local placeholder when nothing was stamped", () => {
    expect(originFor("feature", undefined, {})).toBe(LOCAL_ORIGIN);
  });
});

describe("isPublicHostname", () => {
  test("takes an ordinary hostname", () => {
    for (const hostname of ["example.com", "api.example.com", "a.b.c.example.com", "xn.example.com"]) {
      expect(isPublicHostname(hostname), hostname).toBe(true);
    }
  });

  /**
   * **A punycode label is refused, and the kit decides that rather than a URL parser (#662-adjacent).**
   *
   * `xn--a.test` is a malformed A-label: legal DNS syntax, invalid as an encoding. Nothing here used to
   * say so — `seedHostOrigin` asked `new URL` and took the throw as the answer. Node 24.20.0 bumped Ada
   * from 3.4.4 to 4.0.0, Ada 4 stopped rejecting invalid punycode, and the same `pithy seed --host`
   * started succeeding on Node 24 and failing on Node 22. A rule the kit borrows from a parser is a rule
   * that changes under it, so this states it: an `xn--` label is not a hostname Pithy takes.
   *
   * Whole labels, not a substring — `xn.example.com` and `myxn--a.test` are ordinary names that happen to
   * read that way, and refusing them would be this rule reaching past what it is about.
   */
  test("refuses a punycode label, on every runtime, wherever it sits", () => {
    for (const hostname of [
      "xn--a.test",
      "a.xn--.test",
      "xn--bcher-kva.example",
      "example.xn--p1ai",
      "XN--A.TEST".toLowerCase(),
    ]) {
      expect(isPublicHostname(hostname), hostname).toBe(false);
    }
  });

  test("a label that merely contains xn-- is an ordinary label", () => {
    for (const hostname of ["myxn--a.test", "axn--b.example.com"]) {
      expect(isPublicHostname(hostname), hostname).toBe(true);
    }
  });
});

describe("one hostname rule, reached by every caller", () => {
  /**
   * The table both callers are driven through.
   *
   * A configured domain is a third caller of the rule `isPublicHostname` states, and it did not go
   * through it — `WorkerDomain.pattern` and `.zone` handed `HOSTNAME_PATTERN` to `.regex()` directly, so
   * they took two things the function refuses: a punycode A-label, and a name over the 253-character DNS
   * limit (#665).
   */
  const CASES: { hostname: string; takes: boolean; why: string }[] = [
    { hostname: "api.example.com", takes: true, why: "an ordinary hostname" },
    { hostname: "a.b.c.example.com", takes: true, why: "any number of labels" },
    { hostname: "example.com", takes: true, why: "two labels is the floor" },
    { hostname: "com", takes: false, why: "one label is not a hostname" },
    { hostname: "xn--a.test", takes: false, why: "a punycode A-label" },
    { hostname: "xn--bcher-kva.example", takes: false, why: "a valid A-label is still an A-label" },
    { hostname: "shop.example.xn--p1ai", takes: false, why: "wherever the A-label sits" },
    { hostname: "myxn--notpunycode.de", takes: true, why: "a label that merely reads like one" },
    {
      hostname: `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.example.com`,
      takes: false,
      why: "over the 253-character DNS limit",
    },
    { hostname: "https://api.example.com", takes: false, why: "a URL is not a hostname" },
    { hostname: "api.example.com:8787", takes: false, why: "a port is not part of a hostname" },
  ];

  test("**`WorkerDomain` takes exactly what `isPublicHostname` takes**", () => {
    const disagreements = CASES.filter(({ hostname }) => {
      // `zone` equal to `pattern` so the containment rule cannot be what refuses it — this test is about
      // the hostname rule alone.
      const schema = WorkerDomain.safeParse({ pattern: hostname, zone: hostname }).success;
      return schema !== isPublicHostname(hostname);
    }).map(({ hostname, why }) => `${hostname} — ${why}`);
    expect(disagreements).toEqual([]);
  });

  test("and the table is not vacuous: it holds both answers", () => {
    expect(CASES.some((c) => c.takes)).toBe(true);
    expect(CASES.some((c) => !c.takes)).toBe(true);
    for (const { hostname, takes, why } of CASES) {
      expect(isPublicHostname(hostname), `${hostname} — ${why}`).toBe(takes);
    }
  });

  test("`zone` is held to the rule too, not only `pattern`", () => {
    expect(WorkerDomain.safeParse({ pattern: "api.example.com", zone: "xn--bcher-kva.example" }).success).toBe(false);
  });
});

describe("a refusal says which rule it broke", () => {
  const messageFor = (hostname: string): string => {
    const parsed = WorkerDomain.safeParse({ pattern: hostname, zone: "example.com" });
    if (parsed.success) throw new Error(`${hostname} was accepted`);
    return parsed.error.issues.find((issue) => issue.path[0] === "pattern")?.message ?? "";
  };

  test("**an internationalized domain is named as unsupported, and Cloudflare as the reason**", () => {
    const message = messageFor("xn--bcher-kva.example");
    // The sentence an adopter acts on. Not "a domain is a bare hostname" — `xn--bcher-kva.example` is a
    // bare hostname, so that message would send them hunting a typo they do not have (#665).
    expect(message).toContain("Internationalized domains are not supported");
    expect(message).toContain("Cloudflare Workers");
    expect(message).not.toContain("bare hostname");
  });

  test("a name over the DNS limit says so, with the number", () => {
    const message = messageFor(`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.example.com`);
    expect(message).toContain("253");
    expect(message).not.toContain("Internationalized");
  });

  test("and a shape failure keeps each field's own sentence", () => {
    // Folding three rules into one validator must not cost the two messages their specificity.
    expect(messageFor("https://api.example.com")).toContain("bare hostname");
    const zoneIssue = WorkerDomain.safeParse({ pattern: "api.example.com", zone: "com" });
    expect(zoneIssue.success).toBe(false);
    if (!zoneIssue.success) {
      expect(zoneIssue.error.issues.find((i) => i.path[0] === "zone")?.message).toContain("registrable domain");
    }
  });

  test("every problem the rule can report has a sentence, and none is the generic one", () => {
    // The enumeration, so a fourth reason cannot be added without a message to go with it.
    const problems: HostnameProblem[] = ["too-long", "shape", "punycode"];
    expect(problems.map((p) => publicHostnameProblem(SAMPLES[p]))).toEqual(problems);
  });

  const SAMPLES: Record<HostnameProblem, string> = {
    "too-long": `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.example.com`,
    shape: "https://api.example.com",
    punycode: "xn--bcher-kva.example",
  };
});
