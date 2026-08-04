// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { type Capability, defineCapability, type PithyHonoEnv } from "../capability/capability";
import { CapabilityManifest } from "../capability/manifest";
import {
  CONTROL_PLANE_KV_BINDING,
  CONTROLPLANE_MIGRATION_ORDER,
  controlplane,
  isControlPlaneCapability,
} from "./capability";
import { ControlPlaneConfig } from "./config/config";
import { CONTROL_PLANE_CONNECTIONS_TABLE, CONTROL_PLANE_REPLAYS_TABLE } from "./data/tables";

/**
 * The composed shape of the `control-plane` capability — assertions on the object, no request made.
 *
 * The manifest block below is the one that earns its keep. `pithy add` never executes the package: it
 * reads `pithy.manifest.json` to write bindings into `wrangler.jsonc` and to emit
 * `import { <manifest.name> } from "<package>/src/index"` into a Worker's `pithy.config.ts`. So the
 * manifest and the code can disagree freely and nothing at runtime notices — the adopter finds out when
 * a generated config fails to import, or when a Worker boots without the KV namespace the seam's replay
 * set lives in. These tests are the only thing holding the two together.
 */

/** Every binding a Worker composing this capability must actually have: declared plus derived. */
function composedBindings(capability: Capability): string[] {
  return [
    ...new Set([
      ...capability.requiredBindings.map((binding) => `${binding.type}:${binding.name}`),
      // `createBackend` derives a D1 binding per named database and a KV binding per namespace, so the
      // manifest must list those too even though the capability never repeats them.
      ...Object.values(capability.databases ?? {}).map((database) => `d1:${database.binding}`),
      ...Object.values(capability.kvNamespaces ?? {}).map((namespace) => `kv:${namespace.binding}`),
    ]),
  ].sort();
}

/** Every `<METHOD> <path>` this capability registers, deduped — `app.routes` holds one entry per handler. */
function registeredRoutes(capability: Capability): string[] {
  const app = new Hono<PithyHonoEnv>();
  capability.routes?.(app);
  return [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))].sort();
}

async function manifest() {
  return CapabilityManifest.parse((await import("../../pithy.manifest.json", { with: { type: "json" } })).default);
}

describe("controlplane capability", () => {
  test("is named for its namespace, and carries its resolved config", () => {
    const capability = controlplane();
    expect(capability.name).toBe("controlplane");
    expect(capability.controlPlaneConfig).toEqual(ControlPlaneConfig.parse({}));
    expect(capability.controlPlaneConfig.basePath).toBe("/control-plane");
    expect(capability.config).toBe(ControlPlaneConfig);
  });

  test("parses its options at assembly, so an unsound config fails on deploy and not on a management call", () => {
    // A replay memory shorter than the widest window a token is accepted in is the one misconfiguration
    // that silently reopens replay. It must not be constructible.
    expect(() => controlplane({ jtiTtlSeconds: 30 })).toThrow();
    expect(() => controlplane({ basePath: "control-plane/" })).toThrow();
    expect(controlplane({ maxKeys: 4 }).controlPlaneConfig.maxKeys).toBe(4);
  });

  test("a custom basePath moves every route, not some of them", () => {
    expect(registeredRoutes(controlplane({ basePath: "/admin/cp" }))).toEqual([
      "GET /admin/cp/keys",
      "GET /admin/cp/manifest",
      "GET /admin/cp/ping",
      "POST /admin/cp/keys",
      "POST /admin/cp/keys/:keyId/expire",
    ]);
  });

  test("registers exactly the five seam routes", () => {
    expect(registeredRoutes(controlplane())).toEqual([
      "GET /control-plane/keys",
      "GET /control-plane/manifest",
      "GET /control-plane/ping",
      "POST /control-plane/keys",
      "POST /control-plane/keys/:keyId/expire",
    ]);
  });

  test("sorts at order 1100 in the app database, and declares both seam tables with its migration", () => {
    // Stable forever. Renumbering renames the composed key `1100_controlplane_0001_init`, and
    // Kysely then reads an applied migration as unapplied and runs it again.
    expect(CONTROLPLANE_MIGRATION_ORDER).toBe(1100);
    const app = controlplane().databases?.app;
    expect(app?.binding).toBe("DB");
    expect(app?.migrationOrder).toBe(CONTROLPLANE_MIGRATION_ORDER);
    expect(Object.keys(app?.migrations ?? {})).toEqual(["0001_init"]);
    expect(Object.keys(app?.tables ?? {})).toEqual([CONTROL_PLANE_CONNECTIONS_TABLE, CONTROL_PLANE_REPLAYS_TABLE]);
  });

  test("the default records replays in D1, so a project needs no KV namespace at all", () => {
    // The seam used to demand a `CONTROL_PLANE` KV whatever the adopter did with it. Under the `d1`
    // default nothing in the tree reads that namespace, and requiring it anyway would make every project
    // provision a resource it never touches.
    const capability = controlplane();
    expect(Object.keys(capability.kvNamespaces ?? {})).toEqual([]);
    expect(capability.requiredBindings.map((binding) => `${binding.type}:${binding.name}`)).toEqual(["d1:DB"]);
  });

  test("selecting the KV backend brings its namespace and binding back", () => {
    const capability = controlplane({ replayBackend: "kv" });
    const namespaces = capability.kvNamespaces ?? {};
    expect(Object.keys(namespaces)).toEqual(["controlplane"]);
    expect(namespaces.controlplane?.binding).toBe(CONTROL_PLANE_KV_BINDING);
    expect(CONTROL_PLANE_KV_BINDING).toBe("CONTROL_PLANE");
    expect(capability.requiredBindings.map((binding) => `${binding.type}:${binding.name}`)).toEqual([
      "d1:DB",
      "kv:CONTROL_PLANE",
    ]);
  });

  test("the configured jtiTtlSeconds reaches the KV replay store", () => {
    // The store's TTL used to be a module constant, which made this setting decorative: an adopter who
    // lengthened `maxTokenLifetimeSeconds` and lengthened the replay memory to match — the pairing the
    // config's own cross-field rule tells them to make — still got a 300-second store, and their tokens
    // outlived the memory of them. That is a reopened replay window arrived at by following the docs, so
    // the wiring is asserted rather than assumed. The D1 guard reads the same setting directly.
    const ttl = (capability: ReturnType<typeof controlplane>): number | undefined =>
      capability.kvNamespaces?.controlplane?.stores?.jtis?.ttlSeconds;

    expect(ttl(controlplane({ replayBackend: "kv" }))).toBe(300);
    expect(
      ttl(
        controlplane({ replayBackend: "kv", clockSkewSeconds: 120, maxTokenLifetimeSeconds: 240, jtiTtlSeconds: 600 }),
      ),
    ).toBe(600);
  });

  test("composes into a Worker holding neither auth nor audit nor secrets", () => {
    // No `dependsOn`: the seam holds no secret, mints no session, and emits through a seam that is a
    // no-op when absent. A dependency here would make the admin surface un-composable on its own.
    expect(controlplane().dependsOn).toBeUndefined();
  });

  test("isControlPlaneCapability narrows this capability and rejects any other", () => {
    const capability: Capability = controlplane();
    expect(isControlPlaneCapability(capability)).toBe(true);
    if (isControlPlaneCapability(capability)) {
      // The narrowing is the point: the CLI reads the seam's config off a composed capability list.
      expect(capability.controlPlaneConfig.issuer).toBe("https://app.pithy.sh");
    }
    expect(isControlPlaneCapability(defineCapability({ name: "payments", requiredBindings: [] }))).toBe(false);
  });
});

describe("controlplane pithy.manifest.json", () => {
  test("declares the same bindings the capability needs, derived ones included", async () => {
    // The manifest is what writes `wrangler.jsonc`. A binding the capability derives but the manifest
    // omits is a Worker that boots straight into "Missing required bindings".
    //
    // The manifest is one static file and cannot vary with config, so it declares the union of what any
    // backend needs and marks the KV entry `optional` — `pithy add` then never demands a namespace the
    // `d1` default will not read, while an adopter who selects `kv` still finds it documented and
    // reconciled. The capability's own list is the config-aware one, and is asserted above in both
    // shapes.
    const declared = (await manifest()).requiredBindings.map((binding) => `${binding.type}:${binding.name}`).sort();
    expect(declared).toEqual(composedBindings(controlplane({ replayBackend: "kv" })));
    expect(declared).toEqual(["d1:DB", "kv:CONTROL_PLANE"]);

    const optionalInManifest = (await manifest()).requiredBindings
      .filter((binding) => binding.optional)
      .map((binding) => binding.name);
    expect(optionalInManifest).toEqual(["CONTROL_PLANE"]);
  });

  test("its migrationNamespace is the capability name, the one word every namespace token uses", async () => {
    expect((await manifest()).migrationNamespace).toBe("controlplane");
    expect((await manifest()).migrationNamespace).toBe(controlplane().name);
  });

  test("its name is the identifier src/index.ts exports, because pithy add writes that import", async () => {
    const { name, package: packageName } = await manifest();
    expect(name).toBe(controlplane().name);
    expect(packageName).toBe("@pithy-sh/core");

    // `pithy add controlplane` emits `import { controlplane } from "@pithy-sh/core/src/index"`. A rename
    // on either side generates a config that cannot resolve, and nothing else would catch it.
    const index = (await import("../index")) as unknown as Record<string, unknown>;
    expect(Object.keys(index)).toContain(name);
    expect(index[name]).toBe(controlplane);
  });

  test("every config option it advertises is a real option with that default", async () => {
    // The CLI renders these into a commented `pithy.config.ts`. An option that does not exist, or a
    // default that disagrees with the schema, is config an adopter cannot trust.
    const defaults = ControlPlaneConfig.parse({}) as Record<string, unknown>;
    for (const option of (await manifest()).configOptions) {
      expect(Object.keys(defaults), `configOptions lists ${option.key}, which is not a config field`).toContain(
        option.key,
      );
      expect(defaults[option.key], `configOptions says ${option.key} defaults to ${option.default}`).toBe(
        option.default,
      );
    }
  });
});
