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
  workerVersionMetadata,
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

describe("workerVersionMetadata", () => {
  it("reads every field the binding actually carries", () => {
    // Measured, not taken from the docs. A `wrangler dev` (4.120.1) on a Worker declaring
    // `version_metadata` hands the binding as `{ id, tag, timestamp }` — three own keys, every value a
    // string, `timestamp` an ISO-8601 instant. The module docstring used to say "an id and a tag",
    // which is where the discarded field came from.
    expect(
      workerVersionMetadata({
        CF_VERSION_METADATA: {
          id: "6bbf9e9b-90c6-46c5-829d-83241554ac2c",
          tag: "release-42",
          timestamp: "2026-08-10T21:39:55.716Z",
        },
      }),
    ).toEqual({
      id: "6bbf9e9b-90c6-46c5-829d-83241554ac2c",
      tag: "release-42",
      createdAt: "2026-08-10T21:39:55.716Z",
    });
  });

  it("reads the shape a local wrangler dev actually hands a Worker", () => {
    // The empty tag is not a fixture. Miniflare hardcodes `tag: ""`, and a production version carries
    // one only where someone passed `wrangler versions upload --tag`. Empty means "no tag", so it reads
    // as absent — an empty string on the wire would be a value to compare against.
    expect(
      workerVersionMetadata({
        CF_VERSION_METADATA: {
          id: "954d8c61-daa2-4ebf-9b3c-459b4abe7fcd",
          tag: "",
          timestamp: "2026-08-10T21:40:54.934Z",
        },
      }),
    ).toEqual({ id: "954d8c61-daa2-4ebf-9b3c-459b4abe7fcd", tag: null, createdAt: "2026-08-10T21:40:54.934Z" });
  });

  it("hands back the platform's own string, never a re-serialized one", () => {
    // A client compares and subtracts these. Re-encoding a leniently-parsed date would make this reader
    // the author of a value it only relayed, and `Date.parse` is implementation-defined off ISO-8601 —
    // so the guess would differ between runtimes reading the same deploy.
    const meta = workerVersionMetadata({
      CF_VERSION_METADATA: { id: "v-1", tag: "t", timestamp: "2026-08-10T21:39:55.716Z" },
    });
    expect(meta.createdAt).toBe("2026-08-10T21:39:55.716Z");
  });

  it("refuses a timestamp that is not a time, rather than passing it on", () => {
    // The one place this reader rejects rather than relays, and the reason is the consumer: a client
    // does `Date.parse` on this and compares. An unparseable string becomes `NaN`, and every `NaN`
    // comparison is false — so garbage would read as "not newer", which is silently the same answer as
    // "unchanged". Null says "cannot tell", which is the true one.
    for (const timestamp of ["", "   ", "yesterday", "not-a-date", 1_754_863_195_716, null, {}]) {
      expect(workerVersionMetadata({ CF_VERSION_METADATA: { id: "v-1", timestamp } }).createdAt).toBeNull();
    }
  });

  it("reports every field null where the binding is absent, rather than inventing one", () => {
    // Absence is the ordinary state: local dev before the binding is declared, and every project
    // scaffolded before it existed. Absence must never render as a value a client can compare.
    expect(workerVersionMetadata({})).toEqual({ id: null, tag: null, createdAt: null });
    expect(workerVersionMetadata({ CF_VERSION_METADATA: null })).toEqual({ id: null, tag: null, createdAt: null });
    expect(workerVersionMetadata({ CF_VERSION_METADATA: "v-1" })).toEqual({ id: null, tag: null, createdAt: null });
  });

  it("reads each field on its own, so one absent field does not blank the rest", () => {
    // A partial binding is what a platform change looks like from inside a Worker. Dropping the whole
    // identity because one key moved would turn a field rename into "this Worker cannot say".
    expect(workerVersionMetadata({ CF_VERSION_METADATA: { id: "v-1" } })).toEqual({
      id: "v-1",
      tag: null,
      createdAt: null,
    });
    expect(workerVersionMetadata({ CF_VERSION_METADATA: { timestamp: "2026-08-10T21:39:55.716Z" } })).toEqual({
      id: null,
      tag: null,
      createdAt: "2026-08-10T21:39:55.716Z",
    });
  });

  it("never throws on a non-object env", () => {
    for (const env of [null, undefined, "env", 7, []]) {
      expect(() => workerVersionMetadata(env)).not.toThrow();
      expect(workerVersionMetadata(env)).toEqual({ id: null, tag: null, createdAt: null });
    }
  });

  it("is the one reader — workerVersion is its id and nothing else", () => {
    // Two readers of one binding is how the id and the timestamp drift apart. `workerVersion` keeps its
    // shape because four callers hold it: the logger's correlation field, `/health`, the manifest, and
    // the seam's header.
    const env = { CF_VERSION_METADATA: { id: "v-abc123", tag: "", timestamp: "2026-08-10T21:39:55.716Z" } };
    expect(workerVersion(env)).toBe(workerVersionMetadata(env).id);
    expect(workerVersion(env)).toBe("v-abc123");
  });
});
