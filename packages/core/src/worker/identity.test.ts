// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_VAR,
  PROJECT_VAR,
  VERSION_METADATA_BINDING,
  WORKER_VAR,
  workerIdentity,
  workerVersion,
} from "./identity";

describe("workerIdentity", () => {
  it("reads all three stamped vars", () => {
    expect(workerIdentity({ PROJECT: "acme", ENVIRONMENT: "prod", WORKER: "api" })).toEqual({
      project: "acme",
      environment: "prod",
      worker: "api",
      version: null,
    });
  });

  it("reports a missing var as null rather than guessing one", () => {
    // The whole point of the tri-state. A Worker scaffolded before these vars existed has none of
    // them, and there is no `pithy upgrade` that back-fills — so absent is a permanent, ordinary
    // state, not a misconfiguration to paper over. An invented value would poison an audit trail
    // silently and forever; a null says "not recorded", which is true.
    expect(workerIdentity({})).toEqual({ project: null, environment: null, worker: null, version: null });
    expect(workerIdentity({ PROJECT: "acme" })).toEqual({
      project: "acme",
      environment: null,
      worker: null,
      version: null,
    });
  });

  it("treats an empty or blank var as absent", () => {
    // `"PROJECT": ""` in a wrangler.jsonc stanza is a stamp someone half-finished. Recording the
    // empty string would make it queryable as though it were a project.
    expect(workerIdentity({ PROJECT: "", ENVIRONMENT: "   ", WORKER: "\t" })).toEqual({
      project: null,
      environment: null,
      worker: null,
      version: null,
    });
  });

  it("trims a stamped value, so a stray space cannot fork a project's rows in two", () => {
    expect(workerIdentity({ PROJECT: " acme ", ENVIRONMENT: "prod ", WORKER: " api" })).toEqual({
      project: "acme",
      environment: "prod",
      worker: "api",
      version: null,
    });
  });

  it("ignores a var that is not a string", () => {
    // `env` is `unknown` at the boundary: a binding, a number from a malformed config, anything.
    expect(workerIdentity({ PROJECT: 42, ENVIRONMENT: null, WORKER: { toString: () => "api" } })).toEqual({
      project: null,
      environment: null,
      worker: null,
      version: null,
    });
  });

  it("never throws on a non-object env", () => {
    // Audit is contractually non-fatal. Identity is read on the write path of every event, so a
    // throw here would turn "no origin" into "no audit row at all" — the failure this must not have.
    for (const env of [null, undefined, "env", 7, []]) {
      expect(() => workerIdentity(env)).not.toThrow();
      expect(workerIdentity(env)).toEqual({ project: null, environment: null, worker: null, version: null });
    }
  });

  it("touches only the three vars it names, and never enumerates `env`", () => {
    // The security property, proven rather than asserted. `env` in a deployed Worker holds every secret
    // binding the adopter declared, and in local dev wrangler loads `.dev.vars` — CLOUDFLARE_API_TOKEN
    // included — straight into it. This value is stamped onto every audit row, and an audit table is
    // long-lived and queryable, so anything that enumerated `env` would quietly copy secrets into it
    // forever. A Proxy records every key read; exactly three may be.
    const read: string[] = [];
    const env = new Proxy(
      {
        PROJECT: "acme",
        ENVIRONMENT: "prod",
        WORKER: "api",
        CLOUDFLARE_API_TOKEN: "cfat_supersecret",
        SECRETS_ENCRYPTION_KEYS: "k1",
        STRIPE_SECRET_KEY: "sk_live_1",
      },
      {
        get(target, key: string) {
          read.push(key);
          return target[key as keyof typeof target];
        },
        ownKeys(target) {
          read.push("<enumerated>");
          return Reflect.ownKeys(target);
        },
      },
    );

    const identity = workerIdentity(env);

    expect(read.sort()).toEqual(["CF_VERSION_METADATA", "ENVIRONMENT", "PROJECT", "WORKER"]);
    expect(JSON.stringify(identity)).not.toMatch(/supersecret|sk_live|k1/);
  });

  it("names the vars the scaffolds actually stamp", () => {
    // The join between this reader and the two scaffolds that write the wrangler.jsonc stanzas.
    // Pinned as literals: renaming a constant is free, renaming the var an adopter's deployed
    // Worker already carries is not.
    expect([PROJECT_VAR, ENVIRONMENT_VAR, WORKER_VAR]).toEqual(["PROJECT", "ENVIRONMENT", "WORKER"]);
  });

  it("names the version binding the scaffolds actually declare", () => {
    // Same join, for the binding rather than the vars. The reader shipped once with nothing declaring
    // it, and the `version` field was silently absent in every scaffolded project — pinning the literal
    // is what makes a rename fail here instead of going unnoticed for another release.
    expect(VERSION_METADATA_BINDING).toBe("CF_VERSION_METADATA");
  });
});

describe("workerVersion", () => {
  it("reads the deployed build id off the version-metadata binding", () => {
    expect(workerVersion({ CF_VERSION_METADATA: { id: "v-abc123", tag: "" } })).toBe("v-abc123");
    expect(workerIdentity({ CF_VERSION_METADATA: { id: "v-abc123", tag: "" } }).version).toBe("v-abc123");
  });

  it("reports null where the binding is absent, rather than inventing a build", () => {
    // The ordinary state for any project scaffolded before `version_metadata` was declared, and for
    // every local `wrangler dev`. `deploy` reads null as "cannot tell" and reports its check
    // inconclusive; a fabricated id would make it report a pass.
    expect(workerVersion({})).toBeNull();
    expect(workerVersion({ CF_VERSION_METADATA: null })).toBeNull();
    expect(workerVersion({ CF_VERSION_METADATA: { tag: "v1" } })).toBeNull();
    expect(workerVersion({ CF_VERSION_METADATA: { id: "" } })).toBeNull();
    expect(workerVersion({ CF_VERSION_METADATA: { id: 7 } })).toBeNull();
  });

  it("never throws on a non-object env", () => {
    for (const env of [null, undefined, "env", 7, []]) {
      expect(() => workerVersion(env)).not.toThrow();
      expect(workerVersion(env)).toBeNull();
    }
  });
});
