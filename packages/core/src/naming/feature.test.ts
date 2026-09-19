// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PithyError } from "../error/pithyError";
import {
  assertFeatureProject,
  assertFeatureSlugFits,
  canonicalIssue,
  type FeatureIdentity,
  type FeatureNameShape,
  type FeatureResourceKind,
  featureMarkerInProjectName,
  featureResourceName,
  featureSecretEntryName,
  featureSlugRoom,
  featureWorkerName,
  isFeatureOwnedName,
  maxFeatureSlug,
  parseFeatureName,
} from "./feature";
import { MAX_ISSUE_DIGITS, NAMESPACE_LIMITS } from "./limits";
import { MAX_PROJECT_NAME } from "./resource";

const KINDS: FeatureResourceKind[] = ["d1", "kv", "r2"];

/** R2's charset, the strictest of the three kinds: lowercase, digits, inner hyphens, alphanumeric at both ends. */
const R2_BUCKET = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * A Worker script name: alphanumeric and dashes, never leading or trailing.
 *
 * Character-for-character {@link R2_BUCKET} today, and kept as a second const on purpose: these are two
 * namespaces' published charsets that happen to agree, not one rule written twice. If Cloudflare loosens
 * one, only that one moves.
 */
const WORKER_SCRIPT = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const base: FeatureIdentity = { project: "acme", issue: "69", slug: "media-cli" };

describe("featureResourceName", () => {
  it("composes <project>-f<issue>-<slug>-<binding>-<kind>", () => {
    expect(featureResourceName(base, "ASSETS", "r2")).toBe("acme-f69-media-cli--assets-r2");
    expect(featureResourceName(base, "MY_DB", "d1")).toBe("acme-f69-media-cli--my-db-d1");
  });

  it("stays inside R2's bucket rules for every kind, because one shape serves all three", () => {
    const identity = {
      project: "a".repeat(MAX_PROJECT_NAME),
      issue: "9".repeat(MAX_ISSUE_DIGITS),
      slug: "s",
    };
    for (const kind of KINDS) {
      const name = featureResourceName(identity, "USER_NOTIFICATION_PREF", kind);
      expect(name.length).toBeLessThanOrEqual(NAMESPACE_LIMITS.r2.maxLength);
      expect(name.length).toBeGreaterThanOrEqual(NAMESPACE_LIMITS.r2.minLength);
      expect(name).toMatch(R2_BUCKET);
    }
  });

  it("keeps the slug and a working binding verbatim at the worst legal project name", () => {
    // This is the guarantee `FEATURE_DERIVED_PROJECT_NAME` was derived to give: at the cap, with a
    // six-digit issue, an eleven-character slug and a twelve-character binding still read — eleven since the
    // double hyphen after the slug took one of its characters (#643).
    const identity = {
      project: "a".repeat(MAX_PROJECT_NAME),
      issue: "9".repeat(MAX_ISSUE_DIGITS),
      slug: "media-queue",
    };
    const name = featureResourceName(identity, "MEDIA_BUCKET", "r2");
    expect(name).toContain("-media-queue--media-bucket-r2");
    expect(name.length).toBe(NAMESPACE_LIMITS.r2.maxLength);
  });

  it("is deterministic, and gives each binding and kind its own name", () => {
    // Provision and teardown compute the name rather than storing it, so the same inputs must give
    // the same string — and a `DB` bucket must never be the `DB` database's name.
    expect(featureResourceName(base, "DB", "d1")).toBe(featureResourceName(base, "DB", "d1"));
    const names = new Set([
      featureResourceName(base, "DB", "d1"),
      featureResourceName(base, "DB", "kv"),
      featureResourceName(base, "CACHE", "kv"),
      featureResourceName(base, "ASSETS", "r2"),
    ]);
    expect(names.size).toBe(4);
  });

  it("refuses, rather than truncates, a slug and binding that do not fit together (#643)", () => {
    // Truncation hashed both into a few characters some sibling branch could have as its whole slug.
    const identity = { project: "acme", issue: "123", slug: "z".repeat(50) };
    for (const kind of KINDS) {
      expect(() => featureResourceName(identity, "SOME_VERY_LONG_BINDING_NAME_INDEED", kind)).toThrow(PithyError);
    }
  });

  it("refuses two long slugs sharing a prefix rather than composing either", () => {
    for (const slug of [`${"x".repeat(60)}-one`, `${"x".repeat(60)}-two`]) {
      expect(() => featureResourceName({ project: "acme", issue: "1", slug }, "DB", "d1")).toThrow(PithyError);
    }
  });

  it("refuses an empty slug or binding rather than composing a doubled hyphen", () => {
    // `acme-f69--db-d1` is not a legal bucket name, and it is what an empty segment silently produced.
    expect(() => featureResourceName({ ...base, slug: "" }, "DB", "d1")).toThrow(PithyError);
    expect(() => featureResourceName({ ...base, slug: "!!!" }, "DB", "d1")).toThrow(PithyError);
    expect(() => featureResourceName(base, "", "d1")).toThrow(PithyError);
  });

  it("refuses an issue that is not a number, or is past a million", () => {
    expect(() => featureResourceName({ ...base, issue: "abc" }, "DB", "d1")).toThrow(PithyError);
    expect(() => featureResourceName({ ...base, issue: "" }, "DB", "d1")).toThrow(PithyError);
    expect(() => featureResourceName({ ...base, issue: "9".repeat(MAX_ISSUE_DIGITS) }, "DB", "d1")).not.toThrow();
    expect(() => featureResourceName({ ...base, issue: "9".repeat(MAX_ISSUE_DIGITS + 1) }, "DB", "d1")).toThrow(
      PithyError,
    );
  });
});

describe("featureWorkerName", () => {
  it("composes <project>-f<issue>-<slug>-<worker>", () => {
    expect(featureWorkerName(base, "api")).toBe("acme-f69-media-cli--api");
  });

  it("never runs past the Worker cap — the bug this had", () => {
    // Measured before the fix: 69 characters for `collaboration-realtime-gateway`, 109 for a 70-character
    // worker name. `apps/<name>` has a charset rule and no length rule, so nothing upstream stopped it.
    const name = featureWorkerName(
      { project: "acme", issue: "1", slug: "media-cli" },
      "collaboration-realtime-gateway",
    );
    expect(name.length).toBeLessThanOrEqual(NAMESPACE_LIMITS.worker.maxLength);
    expect(name).toMatch(WORKER_SCRIPT);
    // Past it, refused whole (#643): a truncated script name is one a sibling can compose.
    expect(() => featureWorkerName({ project: "acme", issue: "1", slug: "media-cli" }, "w".repeat(70))).toThrow(
      PithyError,
    );
  });

  it("refuses the worst legal input rather than fitting it", () => {
    const identity = {
      project: "a".repeat(MAX_PROJECT_NAME),
      issue: "9".repeat(MAX_ISSUE_DIGITS),
      slug: "s".repeat(80),
    };
    expect(() => featureWorkerName(identity, "w".repeat(80))).toThrow(PithyError);
    expect(featureWorkerName({ ...identity, slug: "s" }, "api")).toMatch(WORKER_SCRIPT);
  });

  it("lands exactly on the cap without truncating, one character below it", () => {
    // `acme-f1-` is 8 characters; a 55-character tail fills the 63 exactly.
    const identity = { project: "acme", issue: "1", slug: "s".repeat(20) };
    const worker = "w".repeat(NAMESPACE_LIMITS.worker.maxLength - 8 - 20 - 2);
    const name = featureWorkerName(identity, worker);
    expect(name.length).toBe(NAMESPACE_LIMITS.worker.maxLength);
    expect(name).toBe(`acme-f1-${"s".repeat(20)}--${worker}`);
  });

  it("refuses two long worker names rather than colliding on a truncation", () => {
    const identity = { project: "acme", issue: "1", slug: "media-cli" };
    expect(() => featureWorkerName(identity, `${"w".repeat(60)}-alpha`)).toThrow(PithyError);
    expect(() => featureWorkerName(identity, `${"w".repeat(60)}-omega`)).toThrow(PithyError);
  });

  it("refuses an empty worker rather than composing a trailing hyphen", () => {
    // A Worker script name may not end in a dash, so this was an invalid name, not just an ugly one.
    expect(() => featureWorkerName(base, "")).toThrow(PithyError);
    expect(() => featureWorkerName(base, "!!!")).toThrow(PithyError);
  });

  it("is deterministic, so provision and teardown compute the same name", () => {
    expect(featureWorkerName(base, "api")).toBe(featureWorkerName(base, "api"));
    expect(featureWorkerName(base, "api")).not.toBe(featureWorkerName(base, "web"));
  });
});

/**
 * **A feature name parses back to exactly one owner (#643).** The double hyphen ends the slug, and the first
 * `f<digits>` segment is the issue because a project may carry none. That is what the isolation gates ask, and
 * what makes names injective across projects — `feature/naming.property.test.ts` in the CLI holds the property.
 */
describe("parseFeatureName and isFeatureOwnedName", () => {
  const me: FeatureIdentity = { project: "acme", issue: "643", slug: "feature-address" };

  it("reads a feature name back into its project, issue, slug and thing", () => {
    expect(parseFeatureName(featureResourceName(me, "DB", "d1"))).toEqual({
      project: "acme",
      issue: "643",
      slug: "feature-address",
      thing: "db-d1",
    });
    expect(parseFeatureName(featureWorkerName({ project: "a-b", issue: "1", slug: "f3-y" }, "api"))).toEqual({
      project: "a-b",
      issue: "1",
      slug: "f3-y",
      thing: "api",
    });
  });

  it("reads nothing a declared environment composes as a feature's", () => {
    for (const name of ["acme-prod-db", "acme-f12-x-prod-email", "acme-staging-secrets", "acme--f1"]) {
      expect(parseFeatureName(name), name).toBeNull();
    }
  });

  it("owns its own names, and no sibling's", () => {
    const long: FeatureIdentity = { ...me, slug: "s".repeat(20) };
    expect(isFeatureOwnedName(me, featureWorkerName(me, "email"))).toBe(true);
    expect(isFeatureOwnedName(long, featureSecretEntryName(long, "SECRETS_ENCRYPTION_KEYS"))).toBe(true);
    expect(isFeatureOwnedName(long, featureResourceName(long, "USER_NOTIFICATION_PREF", "r2"))).toBe(true);
    for (const other of [
      { ...me, slug: "feature-address-2" },
      { ...me, slug: "feature" },
      { ...me, issue: "6430" },
      { ...me, project: "acme-x" },
    ]) {
      expect(isFeatureOwnedName(me, featureWorkerName(other, "email")), JSON.stringify(other)).toBe(false);
      expect(isFeatureOwnedName(other, featureWorkerName(me, "email")), JSON.stringify(other)).toBe(false);
    }
  });

  it("reads a leading zero as the same issue", () => {
    expect(canonicalIssue("0643")).toBe("643");
    expect(canonicalIssue("0")).toBe("0");
    expect(featureWorkerName({ ...me, issue: "000643" }, "email")).toBe(featureWorkerName(me, "email"));
    expect(isFeatureOwnedName({ ...me, issue: "0643" }, featureWorkerName(me, "email"))).toBe(true);
  });
});

describe("assertFeatureProject", () => {
  it("refuses a project whose name carries an f<digits> segment, and names the segment", () => {
    expect(featureMarkerInProjectName("acme-f12-x")).toBe("f12");
    expect(featureMarkerInProjectName("Acme F7")).toBe("f7");
    expect(featureMarkerInProjectName("acme-fx12")).toBeNull();
    expect(featureMarkerInProjectName("f")).toBeNull();
    expect(() => assertFeatureProject("acme-f12-x")).toThrow("Its name carries f12");
    expect(() => featureWorkerName({ project: "acme-f12-x", issue: "3", slug: "y" }, "api")).toThrow(PithyError);
    expect(() => assertFeatureProject("acme")).not.toThrow();
  });
});

/**
 * **No feature name is truncated (#643, the review of 4828e1fc).** A truncated slug is a hash, and a hash is a
 * slug some sibling can have: `feature/12-login` owned `feature/12-c`'s names, and two long slugs of one issue
 * composed one database. So a slug that does not fit is refused, the refusal names the longest that does, and
 * ownership is an exact parse.
 */
describe("feature slugs are never truncated", () => {
  /** Finding 1, the reviewer's case: `login` owned `c`, because `c` is the first hex of `login`'s hash. */
  it("does not let feature/12-login own feature/12-c's names", () => {
    const login: FeatureIdentity = { project: "acme", issue: "12", slug: "login" };
    const c: FeatureIdentity = { project: "acme", issue: "12", slug: "c" };
    expect(isFeatureOwnedName(login, featureSecretEntryName(c, "ratelimit-1000000001-ns-1001"))).toBe(false);
    expect(isFeatureOwnedName(login, featureWorkerName(c, "api"))).toBe(false);
    expect(isFeatureOwnedName(login, featureResourceName(c, "B", "r2"))).toBe(false);
  });

  /** Finding 1, the reviewer's sweep: no slug owns a one-to-four-character sibling's names unless it is that slug. */
  it("owns a name only when its slug is the feature's slug, character for character", () => {
    const slugs = ["login", "auth", "billing", "signin", "feature-address", "media-cli", "docs", "api", "cache"];
    const siblings = ["a", "b", "c", "d", "e", "f", "1", "2", "3", "db", "ab", "cd", "e2", "42", "1-2", "a-1b"];
    for (const mine of slugs) {
      for (const sibling of siblings) {
        const name = featureSecretEntryName({ project: "acme", issue: "12", slug: sibling }, "x");
        expect(isFeatureOwnedName({ project: "acme", issue: "12", slug: mine }, name), `${mine} / ${sibling}`).toBe(
          false,
        );
      }
    }
  });

  /** Finding 3, the reviewer's case: two long slugs of one issue composed one database. */
  it("refuses a slug that does not fit rather than hashing it into a sibling's name", () => {
    const project = "p".repeat(MAX_PROJECT_NAME);
    for (const slug of ["add-search-import", "add-media-webhook"]) {
      expect(() => featureResourceName({ project, issue: "123456", slug }, "EMAIL_SUPPRESSIONS", "d1")).toThrow(
        PithyError,
      );
    }
  });

  it("names the longest slug the name leaves room for", () => {
    const identity = { project: "acme", issue: "12", slug: "s".repeat(40) };
    // `acme-f12-` is 9, `--email-suppressions-d1` is 23: 63 leaves 31.
    expect(featureSlugRoom(identity, "email-suppressions-d1", NAMESPACE_LIMITS.r2.maxLength)).toBe(31);
    expect(() => featureResourceName(identity, "EMAIL_SUPPRESSIONS", "d1")).toThrow("at most 31");
    const fits = { ...identity, slug: "s".repeat(31) };
    expect(featureResourceName(fits, "EMAIL_SUPPRESSIONS", "d1")).toBe(
      `acme-f12-${"s".repeat(31)}--email-suppressions-d1`,
    );
  });

  it("refuses a binding or Worker too long to leave any slug, and says which", () => {
    const identity = { project: "acme", issue: "12", slug: "x" };
    expect(() => featureWorkerName(identity, "w".repeat(60))).toThrow(`w`.repeat(60));
  });

  it("refuses a slug over the project's budget for every shape, naming the maximum", () => {
    const shapes: FeatureNameShape[] = [
      { label: "a Workflow name", limit: 64, thing: "media-audio-transcribe" },
      { label: "an R2 bucket name", limit: 63, thing: "email-suppressions-d1" },
    ];
    const parts = { project: "acme", issue: "12" };
    // Workflow: 64 - 9 - 2 - 22 = 31. Bucket: 63 - 9 - 2 - 21 = 31. The smaller wins either way.
    expect(maxFeatureSlug(parts, shapes)).toBe(31);
    expect(() => assertFeatureSlugFits({ ...parts, slug: "s".repeat(31) }, shapes)).not.toThrow();
    expect(() => assertFeatureSlugFits({ ...parts, slug: "s".repeat(32) }, shapes)).toThrow(
      "Feature slugs in acme stop at 31 characters at issue 12.",
    );
  });
});
