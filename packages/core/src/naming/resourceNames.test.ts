// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PithyError, ValidationError } from "../error/pithyError";
import { GLOBAL_SCOPE } from "./environment";
import { MAX_ISSUE_DIGITS, MAX_PITHY_NAME, NAMESPACE_LIMITS } from "./limits";
import { MAX_PROJECT_NAME } from "./resource";
import { resourceNames } from "./resourceNames";

const names = resourceNames("acme");

describe("resourceNames", () => {
  it("takes the project once, and keeps it", () => {
    expect(names.project).toBe("acme");
    expect(resourceNames("Acme Corp").project).toBe("acme-corp");
  });

  it("refuses an impossible project at construction, before a single name is composed", () => {
    // The whole point of binding the project once: the refusal lands here, not at the fourth getter.
    expect(() => resourceNames("1password-clone")).toThrow(ValidationError);
    expect(() => resourceNames("a".repeat(MAX_PROJECT_NAME + 1))).toThrow(ValidationError);
    expect(() => resourceNames("")).toThrow(PithyError);
  });

  it("refuses an impossible environment once, not once per resource", () => {
    expect(() => names.env("production")).toThrow(ValidationError);
    expect(() => names.env("Prod")).toThrow(ValidationError);
    expect(() => names.env(GLOBAL_SCOPE)).toThrow(ValidationError);
  });
});

describe("an environment's names", () => {
  const prod = names.env("prod");

  it("composes <project>-<env>-<thing> for every kind", () => {
    expect(prod.worker("email")).toBe("acme-prod-email");
    expect(prod.workflow("email", "send")).toBe("acme-prod-email-send");
    expect(prod.d1("DB")).toBe("acme-prod-db");
    expect(prod.kv("SESSIONS")).toBe("acme-prod-sessions");
    expect(prod.r2("STORAGE_BUCKET")).toBe("acme-prod-storage-bucket");
    expect(prod.vectorizeIndex("docs")).toBe("acme-prod-docs");
    expect(prod.secretEntry("secrets-encryption-keys")).toBe("acme-prod-secrets-encryption-keys");
    expect(prod.apiToken("ci-system")).toBe("acme-prod-ci-system");
  });

  it("stops truncating a KV title against a cap eight times too small", () => {
    // KV titles run to 512. The old shared 63 hashed a title Cloudflare would have taken whole.
    const thing = "s".repeat(100);
    expect(names.env("staging").kv(thing)).toBe(`acme-staging-${thing}`);
    expect(names.env("staging").kv("s".repeat(NAMESPACE_LIMITS.kv.maxLength)).length).toBe(
      NAMESPACE_LIMITS.kv.maxLength,
    );
  });

  it("keeps a secret entry whole, because nothing caps one", () => {
    // The regression this table exists for: at a project name near the cap, `secrets-encryption-keys`
    // used to come out as `secrets-encryp-91c2e9` — hashed against a limit Cloudflare never stated.
    const long = resourceNames("a".repeat(MAX_PROJECT_NAME));
    expect(long.env("staging").secretEntry("secrets-encryption-keys")).toBe(
      `${"a".repeat(MAX_PROJECT_NAME)}-staging-secrets-encryption-keys`,
    );
  });

  it("still refuses to grow a name without end, at Pithy's own ceiling", () => {
    // No published cap is not the same as no cap. This one is ours, and it is enforced by truncation.
    const name = names.env("prod").d1("d".repeat(MAX_PITHY_NAME));
    expect(name.length).toBe(MAX_PITHY_NAME);
    expect(name.startsWith("acme-prod-")).toBe(true);
  });

  it("truncates an R2 bucket at 63 and still satisfies R2's charset", () => {
    // R2 is the one namespace where 63 is real, and it demands alphanumeric at both ends.
    const name = prod.r2("b".repeat(120));
    expect(name.length).toBe(NAMESPACE_LIMITS.r2.maxLength);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it("refuses rather than truncates where a rename would orphan something", () => {
    // A Worker script, a Workflow, and a Vectorize index are addressed by name by things that
    // outlive the command. Silently shortening one is worse than failing the deploy.
    expect(() => prod.worker("w".repeat(80))).toThrow(PithyError);
    expect(() => prod.workflow("media", "j".repeat(60))).toThrow(PithyError);
    expect(() => prod.vectorizeIndex("i".repeat(80))).toThrow(PithyError);
  });

  it("names the namespace in the refusal, so the message says which limit was hit", () => {
    const error = (() => {
      try {
        prod.vectorizeIndex("i".repeat(80));
        return undefined;
      } catch (thrown) {
        return thrown as PithyError;
      }
    })();
    expect(error?.payload.message).toContain(String(NAMESPACE_LIMITS.vectorizeIndex.maxLength));
  });

  it("rejects an empty thing rather than composing a trailing hyphen", () => {
    expect(() => prod.d1("")).toThrow(PithyError);
    expect(() => prod.kv("!!!")).toThrow(PithyError);
  });
});

describe("the global scope", () => {
  it("is reachable without typing the word, and puts it in the environment slot", () => {
    expect(names.global.secretEntry("secrets-manager-cf-api-token")).toBe("acme-global-secrets-manager-cf-api-token");
    expect(names.global.apiToken("secrets-manager")).toBe("acme-global-secrets-manager");
    expect(names.global.worker("support")).toBe("acme-global-support");
  });

  it("is the same interface as an environment, so no call site special-cases it", () => {
    const prod = names.env("prod");
    for (const key of Object.keys(prod)) expect(names.global).toHaveProperty(key);
  });
});

describe("a feature's names", () => {
  const feature = names.feature({ issue: "95", slug: "media-cli" });

  it("reaches the feature shape from the same object, with the project already bound", () => {
    expect(feature.resource("DB", "d1")).toBe("acme-f95-media-cli-db-d1");
    expect(feature.worker("api")).toBe("acme-f95-media-cli-api");
  });

  it("holds every feature name inside the Worker and R2 caps", () => {
    const big = resourceNames("a".repeat(MAX_PROJECT_NAME)).feature({
      issue: "9".repeat(MAX_ISSUE_DIGITS),
      slug: "s".repeat(60),
    });
    expect(big.resource("SOME_VERY_LONG_BINDING_NAME", "kv").length).toBeLessThanOrEqual(NAMESPACE_LIMITS.r2.maxLength);
    expect(big.worker("w".repeat(60)).length).toBeLessThanOrEqual(NAMESPACE_LIMITS.worker.maxLength);
  });
});
