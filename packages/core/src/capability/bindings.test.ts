// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  BindingSpec,
  BindingType,
  isProvisionedBinding,
  isWrittenBinding,
  type SeedPolicy,
  seedPolicy,
} from "./bindings";

describe("BindingType", () => {
  test("accepts each known resource kind", () => {
    for (const t of [
      "d1",
      "kv",
      "r2",
      "ai",
      "vectorize",
      "queue",
      "ratelimit",
      "email",
      "secret",
      "workflow",
      "service",
      "durable_object",
      "hyperdrive",
      "browser",
      "images",
      "analytics_engine_datasets",
      "pipelines",
      "mtls_certificates",
      "dispatch_namespaces",
      "artifacts",
    ]) {
      expect(BindingType.parse(t)).toBe(t);
    }
  });

  test("rejects an unknown kind", () => {
    expect(() => BindingType.parse("banana")).toThrow();
  });
});

/**
 * The answer `seedPolicy` gives for every kind, written out here so a member added to `BindingType` without one
 * fails this file rather than inheriting a default (#662).
 */
const SEED_POLICIES: Record<string, SeedPolicy> = {
  ai: "carry",
  ratelimit: "carry",
  browser: "carry",
  images: "carry",
  hyperdrive: "branch",
  analytics_engine_datasets: "carry",
  mtls_certificates: "carry",
  dispatch_namespaces: "carry",
  pipelines: "branch",
  d1: "provision",
  kv: "provision",
  r2: "provision",
  vectorize: "provision",
  queue: "provision",
  durable_object: "provision",
  workflow: "provision",
  service: "provision",
  secret: "provision",
  email: "branch",
  artifacts: "provision",
};

describe("seedPolicy", () => {
  test("answers for every BindingType member, and the answer is the one this file states", () => {
    for (const option of BindingType.options) {
      const type = option.value;
      expect(SEED_POLICIES[type], `no stated seed policy for ${type}`).toBeDefined();
      expect(seedPolicy(type)).toBe(SEED_POLICIES[type]);
    }
    expect(Object.keys(SEED_POLICIES).sort()).toEqual(BindingType.options.map((option) => option.value).sort());
  });

  test("is three-valued: a feature inherits dev's mail routing, a declared environment does not", () => {
    // `send_email` proved a boolean is too few (#650 review). Carrying it everywhere wrote a laptop's address
    // into production's first stanza; emptying it everywhere left a feature with no `NOTIFY`.
    expect(new Set(BindingType.options.map((option) => seedPolicy(option.value)))).toEqual(
      new Set(["carry", "provision", "branch"]),
    );
  });
});

describe("isWrittenBinding", () => {
  test("writes every pure-wrangler-entry kind, and provisions none of them", () => {
    for (const type of [
      "hyperdrive",
      "browser",
      "images",
      "analytics_engine_datasets",
      "pipelines",
      "mtls_certificates",
      "dispatch_namespaces",
    ] as const) {
      expect(isWrittenBinding(type), type).toBe(true);
      expect(isProvisionedBinding(type), type).toBe(false);
    }
  });

  test("writes a queue's producer entry and an email's send_email entry", () => {
    // Both were in neither set, so `appendBinding` answered `unsupported` and nothing anywhere wrote them.
    expect(isWrittenBinding("queue")).toBe(true);
    expect(isWrittenBinding("email")).toBe(true);
  });

  test("writes an artifacts entry, and provisions no resource behind it (#673)", () => {
    // `{ binding, namespace }`, and the namespace is derived from the project and the environment alone. Cloudflare
    // makes the namespace on the first repo, so there is nothing for a provisioner to create.
    expect(isWrittenBinding("artifacts")).toBe(true);
    expect(isProvisionedBinding("artifacts")).toBe(false);
  });
});

describe("BindingSpec", () => {
  test("parses a valid binding, defaulting optional to false", () => {
    expect(BindingSpec.parse({ type: "d1", name: "DB" })).toEqual({
      type: "d1",
      name: "DB",
      optional: false,
    });
  });

  test("rejects an unknown binding type", () => {
    expect(() => BindingSpec.parse({ type: "banana", name: "Q" })).toThrow();
  });

  test("rejects an empty name", () => {
    expect(() => BindingSpec.parse({ type: "kv", name: "" })).toThrow();
  });

  test("parses a durable_object binding carrying its class name and the module it comes from", () => {
    expect(
      BindingSpec.parse({
        type: "durable_object",
        name: "SESSIONS",
        className: "MultiplayerSession",
        classModule: "@pithy-sh/multiplayer/src/session/durableObject",
      }),
    ).toEqual({
      type: "durable_object",
      name: "SESSIONS",
      optional: false,
      className: "MultiplayerSession",
      classModule: "@pithy-sh/multiplayer/src/session/durableObject",
    });
  });

  test("rejects a durable_object binding with no className", () => {
    expect(() =>
      BindingSpec.parse({ type: "durable_object", name: "SESSIONS", classModule: "@pithy-sh/x/src/do" }),
    ).toThrow(/className/);
  });

  test("rejects a durable_object binding with no classModule", () => {
    // The other half of the binding. Without it the CLI writes the `durable_objects.bindings` entry and
    // the class migration tag, has nowhere to write the export from, and the deploy fails on a class
    // "not exported in your entrypoint file" (#428).
    expect(() => BindingSpec.parse({ type: "durable_object", name: "SESSIONS", className: "Session" })).toThrow(
      /classModule/,
    );
  });

  test("rejects a className that is not an identifier, and a classModule that is not a specifier", () => {
    // Both land in generated TypeScript — `export { <className> } from "<classModule>";` — built from a
    // manifest, which is third-party data read out of node_modules. The shape #183 closed one field up.
    const base = { type: "durable_object", name: "SESSIONS" };
    for (const className of ["Session } from 'evil'; //", "class-name", "1Session"]) {
      expect(() => BindingSpec.parse({ ...base, className, classModule: "@pithy-sh/x/src/do" })).toThrow(/className/);
    }
    for (const classModule of ['x"; import "evil', "@pithy-sh/x/../../elsewhere", "./local module"]) {
      expect(() => BindingSpec.parse({ ...base, className: "Session", classModule })).toThrow(/classModule/);
    }
  });

  test("round-trips a project-global resource, with its own <thing> segment", () => {
    // The two fields #513 adds, on the one kind that has a provisioned resource to name. `optional` is
    // still the only key a parse invents — `scope` and `resource` are `.optional()` rather than
    // `.default()`, so a spec that says nothing about either stays byte-identical through a parse.
    expect(BindingSpec.parse({ type: "r2", name: "SUPPORT_BUCKET", scope: "global", resource: "support" })).toEqual({
      type: "r2",
      name: "SUPPORT_BUCKET",
      optional: false,
      scope: "global",
      resource: "support",
    });
  });

  test("rejects a scope or a resource on a kind with no provisioned resource to name", () => {
    // A Workflow's name is `<project>-<env>-<capability>-<job>` and has no `<thing>` slot; a secret
    // states its scope in `defineSecretRegistry`. Either field here describes a name nothing composes, so
    // it is refused at parse — attributed to the binding — rather than dropped by a writer that would
    // leave the manifest reading like the declaration was honored.
    const workflow = { type: "workflow", name: "EMAIL_SENDER", job: "send", className: "EmailSendWorkflow" };
    expect(() => BindingSpec.parse({ ...workflow, scope: "global" })).toThrow(/EMAIL_SENDER/);
    expect(() => BindingSpec.parse({ ...workflow, resource: "sender" })).toThrow(/EMAIL_SENDER/);
  });

  test("rejects a resource segment a composed name could not carry", () => {
    // Same argument as `job`: a manifest is third-party data out of `node_modules` and this string lands
    // in a Cloudflare resource name, so the segment rule is asserted at parse rather than at the composer.
    for (const resource of ["Support", "support_bucket", "-support", "support bucket"]) {
      expect(() => BindingSpec.parse({ type: "r2", name: "SUPPORT_BUCKET", resource })).toThrow(/resource/);
    }
  });

  test("takes the account-level resource a carried kind addresses, and requires it where wrangler does", () => {
    expect(
      BindingSpec.parse({ type: "hyperdrive", name: "HYPERDRIVE", target: "a76a99bc342644deb02c38d66082262a" }),
    ).toEqual({ type: "hyperdrive", name: "HYPERDRIVE", optional: false, target: "a76a99bc342644deb02c38d66082262a" });
    // Wrangler refuses each of these entries without the resource it names, so the spec refuses it first,
    // attributed to the binding, before any writer could emit a config that will not load.
    for (const type of ["hyperdrive", "mtls_certificates", "pipelines", "dispatch_namespaces"]) {
      expect(() => BindingSpec.parse({ type, name: "THING" }), type).toThrow(/THING.*target/);
    }
    // A dataset is optional to wrangler, so it is optional here.
    expect(BindingSpec.parse({ type: "analytics_engine_datasets", name: "EVENTS" })).toEqual({
      type: "analytics_engine_datasets",
      name: "EVENTS",
      optional: false,
    });
  });

  test("refuses a target that is not an id or a resource name", () => {
    for (const target of ['x", "evil": "', "two words", "-leading"]) {
      expect(() => BindingSpec.parse({ type: "hyperdrive", name: "HYPERDRIVE", target }), target).toThrow(/target/);
    }
  });

  test("refuses a target on a kind that addresses no account-level resource by it", () => {
    for (const type of ["d1", "browser", "images", "ai", "queue"]) {
      expect(() => BindingSpec.parse({ type, name: "THING", target: "x" }), type).toThrow(/THING.*target/);
    }
  });

  test("names a queue's resource like a d1's: scope and resource are honored", () => {
    // A queue is the fourth kind Pithy names and creates (#662), so the two naming fields mean something on it.
    expect(BindingSpec.parse({ type: "queue", name: "JOBS", scope: "global", resource: "jobs" })).toEqual({
      type: "queue",
      name: "JOBS",
      optional: false,
      scope: "global",
      resource: "jobs",
    });
  });

  test("ignores a key it has never heard of, so an older kit can still read a newer manifest", () => {
    // A manifest ships in the capability's package and is parsed by whatever CLI the adopter has. A field
    // a later release adds must degrade to "not stated" in an earlier one — refusing it would take a
    // capability that installed fine and make it unreadable on the version that was already working.
    expect(BindingSpec.parse({ type: "d1", name: "DB", futureField: "whatever it turns out to be" })).toEqual({
      type: "d1",
      name: "DB",
      optional: false,
    });
  });
});

describe("BindingType descriptions", () => {
  test("every option carries a non-empty description (self-documenting)", () => {
    expect(BindingType.options).toHaveLength(20);
    for (const option of BindingType.options) {
      expect(option.description).toBeTruthy();
    }
  });
});
