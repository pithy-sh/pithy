# Pithy Capability Contract + Migration Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the `Capability` contract, the `AuthContext` + verification-strategy seam, the static capability manifest, and the namespaced migration registry that merges every capability's Kysely migrations into one deterministically-ordered run.

**Architecture:** Pure type + logic layer in `@pithy-sh/core`. The `Capability` interface is the single composition contract (config/migrations/routes/middleware/bindings, each optional). `AuthContext` is a Zod object defining the seam core exposes and `@pithy-sh/auth` later fills. The migration registry composes namespaced Kysely migration sets into a single `MigrationProvider` whose keys are **stable and globally sortable** via a per-capability `order` (core first, app last) — the critical property that lets package upgrades ship new migrations without renumbering existing ones.

**Tech Stack:** TypeScript (TS-7-ready), Zod 4, Kysely (types only here), Vitest.

**Prerequisite:** Plan 1 complete (`@pithy-sh/core` exists with codecs; Bun/Turbo/Biome/Vitest wired).

**Conventions:** Zod object const + inferred type share the same name (no `Schema`); **every Zod field + object/enum has a `.describe()`** (spec §6.8); ESM only; no barrels; `bunx`/`bun run`; tests co-located.

---

### Task 1: Add Kysely dependency to `@pithy-sh/core`

**Files:**
- Modify: `packages/@pithy-sh/core/package.json`

- [ ] **Step 1: Add `kysely` as a dependency**

Run: `bun add kysely@^0.27.0 --filter @pithy-sh/core`
Expected: `kysely` appears in `packages/@pithy-sh/core/package.json` dependencies.

- [ ] **Step 2: Verify it resolves**

Run: `bun install`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/@pithy-sh/core/package.json bun.lockb
git commit -m "chore(core): add kysely dependency"
```

---

### Task 2: Binding spec + verification strategy types

**Files:**
- Create: `packages/@pithy-sh/core/src/bindings.ts`
- Test: `packages/@pithy-sh/core/src/bindings.test.ts`

These are Zod data objects (validated at the manifest boundary), so they follow the naming rule.

- [ ] **Step 1: Write the failing test**

```ts
// packages/@pithy-sh/core/src/bindings.test.ts
import { describe, expect, test } from "vitest";
import { BindingSpec, VerificationStrategy } from "./bindings";

describe("BindingSpec", () => {
  test("parses a valid D1 binding", () => {
    expect(BindingSpec.parse({ type: "d1", name: "DB" })).toEqual({
      type: "d1",
      name: "DB",
      optional: false,
    });
  });

  test("rejects an unknown binding type", () => {
    expect(() => BindingSpec.parse({ type: "queue", name: "Q" })).toThrow();
  });
});

describe("VerificationStrategy", () => {
  test("accepts each known strategy", () => {
    for (const s of ["bearer", "session", "turnstile", "signed-webhook", "control-plane", "public"]) {
      expect(VerificationStrategy.parse(s)).toBe(s);
    }
  });

  test("rejects an unknown strategy", () => {
    expect(() => VerificationStrategy.parse("magic")).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — `Cannot find module './bindings'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/@pithy-sh/core/src/bindings.ts
import { z } from "zod";

export const BindingType = z
  .enum(["d1", "kv", "email", "secret", "workflow"])
  .describe("Kind of Cloudflare resource a binding refers to.");
export type BindingType = z.infer<typeof BindingType>;

export const BindingSpec = z
  .object({
    type: BindingType.describe("Resource kind this binding provides."),
    name: z
      .string()
      .min(1)
      .describe('Binding name expected in the Worker env (e.g. "DB", "SESSIONS").'),
    optional: z
      .boolean()
      .default(false)
      .describe("If true, createBackend will not fail when this binding is absent."),
  })
  .describe("Declares a Cloudflare binding a capability requires in the Worker env.");
export type BindingSpec = z.infer<typeof BindingSpec>;

export const VerificationStrategy = z
  .enum(["bearer", "session", "turnstile", "signed-webhook", "control-plane", "public"])
  .describe("How a route authenticates the caller. There is no implicit auth.");
export type VerificationStrategy = z.infer<typeof VerificationStrategy>;
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/@pithy-sh/core/src/bindings.ts packages/@pithy-sh/core/src/bindings.test.ts
git commit -m "feat(core): add BindingSpec and VerificationStrategy"
```

---

### Task 3: The `AuthContext` seam

**Files:**
- Create: `packages/@pithy-sh/core/src/authContext.ts`
- Test: `packages/@pithy-sh/core/src/authContext.test.ts`

Core defines this shape; `@pithy-sh/auth` later populates it. No auth logic here.

- [ ] **Step 1: Write the failing test**

```ts
// packages/@pithy-sh/core/src/authContext.test.ts
import { describe, expect, test } from "vitest";
import { AuthContext } from "./authContext";

describe("AuthContext", () => {
  test("parses a full context", () => {
    expect(AuthContext.parse({ userId: "u1", sessionId: "s1", scopes: ["read"] })).toEqual({
      userId: "u1",
      sessionId: "s1",
      scopes: ["read"],
    });
  });

  test("defaults scopes to an empty array", () => {
    expect(AuthContext.parse({ userId: "u1", sessionId: "s1" }).scopes).toEqual([]);
  });

  test("rejects a context missing userId", () => {
    expect(() => AuthContext.parse({ sessionId: "s1" })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/@pithy-sh/core/src/authContext.ts
import { z } from "zod";

/**
 * The auth seam. @pithy-sh/core defines this shape; @pithy-sh/auth populates it on the
 * request via the `bearer`/`session` verification strategies. Other capabilities depend
 * only on this object (+ requireAuth), never on auth internals.
 */
export const AuthContext = z
  .object({
    userId: z.string().describe("ID of the authenticated user (populated by @pithy-sh/auth)."),
    sessionId: z.string().describe("ID of the active session this request belongs to."),
    scopes: z
      .array(z.string())
      .default([])
      .describe("Permission scopes granted to this session."),
  })
  .describe("Per-request authenticated identity; the seam other capabilities depend on.");
export type AuthContext = z.infer<typeof AuthContext>;
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/@pithy-sh/core/src/authContext.ts packages/@pithy-sh/core/src/authContext.test.ts
git commit -m "feat(core): add AuthContext seam"
```

---

### Task 4: The `Capability` contract type

**Files:**
- Create: `packages/@pithy-sh/core/src/capability.ts`
- Test: `packages/@pithy-sh/core/src/capability.test.ts`

This is a TypeScript interface (it holds functions and a Kysely provider, not plain data), so it's a `.ts` type with a small runtime helper `defineCapability` for inference + a type-level test.

- [ ] **Step 1: Write the failing test**

```ts
// packages/@pithy-sh/core/src/capability.test.ts
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "./capability";

describe("defineCapability", () => {
  test("returns the capability object unchanged (identity for inference)", () => {
    const cap = defineCapability({
      name: "turnstile",
      requiredBindings: [{ type: "secret", name: "TURNSTILE_SECRET" }],
      middleware: [],
    });
    expect(cap.name).toBe("turnstile");
    expect(cap.requiredBindings[0]?.name).toBe("TURNSTILE_SECRET");
  });

  test("supports a config-only capability", () => {
    const cap = defineCapability({
      name: "example",
      config: z.object({ enabled: z.boolean() }),
      requiredBindings: [],
    });
    expect(cap.config?.parse({ enabled: true })).toEqual({ enabled: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/@pithy-sh/core/src/capability.ts
import type { Hono } from "hono";
import type { MigrationProvider } from "kysely";
import type { z } from "zod";
import type { BindingSpec } from "./bindings";

/** Hono env shape every capability's routes are typed against. Extended in createBackend plan. */
export interface PithyVars {
  auth: import("./authContext").AuthContext | null;
}
export type PithyHonoEnv = { Bindings: Record<string, unknown>; Variables: PithyVars };

export type PithyMiddleware = (
  app: Hono<PithyHonoEnv>,
) => void;

/** A registered durable job (Cloudflare Workflow) — wired fully in a later phase. */
export interface WorkflowSpec {
  name: string;
  /** The binding name of the Workflow in the Worker env. */
  binding: string;
}

/**
 * The single composition contract. core, each capability, and the app all implement it,
 * contributing any subset of {config, migrations, routes, middleware, workflows, bindings}.
 */
export interface Capability {
  name: string;
  /** Validated env/config/secrets for this capability. */
  config?: z.ZodTypeAny;
  /** Namespaced Kysely migration provider (see migrations/registry). */
  migrations?: MigrationProvider;
  /** Sort order for this capability's migrations relative to others (core low, app high). */
  migrationOrder?: number;
  /** Mounts a Hono sub-router. */
  routes?: (app: Hono<PithyHonoEnv>) => void;
  /** Composable middleware (e.g. turnstile(), requireAuth()). */
  middleware?: PithyMiddleware[];
  /** Durable jobs this capability registers. */
  workflows?: WorkflowSpec[];
  /** Bindings (D1/KV/email/secret/workflow) this capability needs in the env. */
  requiredBindings: BindingSpec[];
}

/** Identity helper for type inference when authoring a capability. */
export function defineCapability(capability: Capability): Capability {
  return capability;
}
```

- [ ] **Step 4: Add `hono` as a dependency (needed for the types above)**

Run: `bun add hono@^4.6.0 --filter @pithy-sh/core`
Expected: `hono` added to dependencies.

- [ ] **Step 5: Run to verify it passes + typecheck**

Run: `bun run --filter @pithy-sh/core test && bun run --filter @pithy-sh/core typecheck`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add packages/@pithy-sh/core/src/capability.ts packages/@pithy-sh/core/src/capability.test.ts packages/@pithy-sh/core/package.json bun.lockb
git commit -m "feat(core): add Capability contract"
```

---

### Task 5: Namespaced migration registry — stable, globally-ordered keys

**Files:**
- Create: `packages/@pithy-sh/core/src/migrations/registry.ts`
- Test: `packages/@pithy-sh/core/src/migrations/registry.test.ts`

The core property (spec §2.4, §6.5): each capability ships migrations with **stable local keys** (`0001_init`); the registry composes a global key `NNNN_<namespace>_<localKey>` where `NNNN` is the capability's zero-padded `order`. Keys never change across releases (so Kysely's recorded names stay valid); new migrations append within a namespace; cross-capability order is fixed by `order` (core=0, app large). Kysely runs migrations in alphanumeric key order, so this guarantees library-before-app and dependency order.

- [ ] **Step 1: Write the failing test**

```ts
// packages/@pithy-sh/core/src/migrations/registry.test.ts
import { describe, expect, test } from "vitest";
import type { Migration } from "kysely";
import { createMigrationRegistry } from "./registry";

const noop: Migration = { up: async () => {}, down: async () => {} };

describe("createMigrationRegistry", () => {
  test("composes globally-ordered keys: core before app", async () => {
    const provider = createMigrationRegistry([
      { namespace: "app", order: 1000, migrations: { "0001_init": noop } },
      { namespace: "core", order: 0, migrations: { "0001_init": noop } },
      { namespace: "auth", order: 100, migrations: { "0001_init": noop, "0002_sessions": noop } },
    ]);
    const keys = Object.keys(await provider.getMigrations());
    expect(keys).toEqual([
      "0000_core_0001_init",
      "0100_auth_0001_init",
      "0100_auth_0002_sessions",
      "1000_app_0001_init",
    ]);
  });

  test("keys are stable regardless of input array order", async () => {
    const a = createMigrationRegistry([
      { namespace: "auth", order: 100, migrations: { "0001_init": noop } },
      { namespace: "core", order: 0, migrations: { "0001_init": noop } },
    ]);
    const b = createMigrationRegistry([
      { namespace: "core", order: 0, migrations: { "0001_init": noop } },
      { namespace: "auth", order: 100, migrations: { "0001_init": noop } },
    ]);
    expect(Object.keys(await a.getMigrations())).toEqual(Object.keys(await b.getMigrations()));
  });

  test("throws on duplicate order values", () => {
    expect(() =>
      createMigrationRegistry([
        { namespace: "auth", order: 100, migrations: { "0001_init": noop } },
        { namespace: "billing", order: 100, migrations: { "0001_init": noop } },
      ]),
    ).toThrow(/duplicate migration order/i);
  });

  test("throws on duplicate namespace", () => {
    expect(() =>
      createMigrationRegistry([
        { namespace: "auth", order: 100, migrations: { "0001_init": noop } },
        { namespace: "auth", order: 200, migrations: { "0001_init": noop } },
      ]),
    ).toThrow(/duplicate namespace/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/@pithy-sh/core/src/migrations/registry.ts
import type { Migration, MigrationProvider } from "kysely";

export interface NamespacedMigrations {
  /** Capability namespace, e.g. "core", "auth", "app". */
  namespace: string;
  /** Global sort order (core low, app high). Must be unique across the set. */
  order: number;
  /** Stable, per-namespace migration keys (e.g. "0001_init"), already locally sorted by key. */
  migrations: Record<string, Migration>;
}

function padOrder(order: number): string {
  return String(order).padStart(4, "0");
}

/**
 * Merge namespaced migration sets into one MigrationProvider with stable, globally-sortable
 * keys: `NNNN_<namespace>_<localKey>`. Kysely runs migrations in alphanumeric key order,
 * so this enforces core-before-app and cross-capability dependency order.
 */
export function createMigrationRegistry(sets: NamespacedMigrations[]): MigrationProvider {
  const seenOrders = new Set<number>();
  const seenNamespaces = new Set<string>();

  for (const set of sets) {
    if (seenOrders.has(set.order)) {
      throw new Error(`duplicate migration order ${set.order} (namespace "${set.namespace}")`);
    }
    if (seenNamespaces.has(set.namespace)) {
      throw new Error(`duplicate namespace "${set.namespace}"`);
    }
    seenOrders.add(set.order);
    seenNamespaces.add(set.namespace);
  }

  const composed: Record<string, Migration> = {};
  for (const set of [...sets].sort((a, b) => a.order - b.order)) {
    const localKeys = Object.keys(set.migrations).sort();
    for (const localKey of localKeys) {
      const globalKey = `${padOrder(set.order)}_${set.namespace}_${localKey}`;
      const migration = set.migrations[localKey];
      if (migration) composed[globalKey] = migration;
    }
  }

  return {
    getMigrations: async (): Promise<Record<string, Migration>> => composed,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS — all 4 registry tests green. (JS object key insertion order is preserved for string keys, so `Object.keys` returns them in insertion order, which we built in sorted order.)

- [ ] **Step 5: Commit**

```bash
git add packages/@pithy-sh/core/src/migrations/registry.ts packages/@pithy-sh/core/src/migrations/registry.test.ts
git commit -m "feat(core): add namespaced migration registry"
```

---

### Task 6: The static capability manifest schema

**Files:**
- Create: `packages/@pithy-sh/core/src/manifest.ts`
- Test: `packages/@pithy-sh/core/src/manifest.test.ts`

The manifest is the **declarative, CLI-facing** description of a capability (spec §7) — read by `pithy add`/`upgrade` without executing the package. It's plain data, so it's a validated Zod object.

- [ ] **Step 1: Write the failing test**

```ts
// packages/@pithy-sh/core/src/manifest.test.ts
import { describe, expect, test } from "vitest";
import { CapabilityManifest } from "./manifest";

describe("CapabilityManifest", () => {
  test("parses a full auth manifest", () => {
    const parsed = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [
        { type: "d1", name: "DB" },
        { type: "kv", name: "SESSIONS" },
      ],
      peerCapabilities: ["email"],
      optionalCapabilities: ["turnstile"],
      migrationNamespace: "auth",
      scaffold: ["register auth() in pithy.config.ts"],
    });
    expect(parsed.name).toBe("auth");
    expect(parsed.peerCapabilities).toEqual(["email"]);
  });

  test("applies empty-array defaults for optional lists", () => {
    const parsed = CapabilityManifest.parse({
      name: "turnstile",
      package: "@pithy-sh/turnstile",
      requiredBindings: [{ type: "secret", name: "TURNSTILE_SECRET" }],
    });
    expect(parsed.peerCapabilities).toEqual([]);
    expect(parsed.optionalCapabilities).toEqual([]);
    expect(parsed.scaffold).toEqual([]);
  });

  test("rejects a manifest with no package", () => {
    expect(() => CapabilityManifest.parse({ name: "x", requiredBindings: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/@pithy-sh/core/src/manifest.ts
import { z } from "zod";
import { BindingSpec } from "./bindings";

/**
 * Declarative, CLI-facing description of a capability. Lives at pithy.manifest.json in
 * each capability package; read by `pithy add`/`upgrade` to mutate wrangler.jsonc and
 * scaffold wiring without executing the package.
 */
export const CapabilityManifest = z
  .object({
    name: z.string().min(1).describe("Capability name, e.g. \"auth\"."),
    package: z.string().min(1).describe("npm package providing this capability."),
    requiredBindings: z.array(BindingSpec).describe("Bindings the CLI must wire into wrangler.jsonc."),
    peerCapabilities: z
      .array(z.string())
      .default([])
      .describe("Capabilities that must also be present (e.g. auth ⇒ email)."),
    optionalCapabilities: z
      .array(z.string())
      .default([])
      .describe("Capabilities that, if present, get wired together (e.g. turnstile onto auth)."),
    migrationNamespace: z
      .string()
      .optional()
      .describe("Namespace prefix for this capability's migrations (e.g. \"auth\")."),
    scaffold: z
      .array(z.string())
      .default([])
      .describe("Human-readable scaffold steps the CLI performs/explains."),
    whenToEnable: z
      .string()
      .optional()
      .describe("Self-documenting rationale surfaced by the CLI (spec §10.15)."),
  })
  .describe("Declarative, CLI-facing description of a capability (pithy.manifest.json).");
export type CapabilityManifest = z.infer<typeof CapabilityManifest>;
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/@pithy-sh/core/src/manifest.ts packages/@pithy-sh/core/src/manifest.test.ts
git commit -m "feat(core): add CapabilityManifest schema"
```

---

## Self-Review

**1. Spec coverage:** Capability contract with independently-optional contributions (§7) — Task 4 ✅. Manifest (§7) — Task 6 ✅. AuthContext seam (§5) — Task 3 ✅. Verification strategies (§5) — Task 2 ✅. BindingSpec incl. `workflow` type (§6, §10.10) — Task 2 ✅. Namespaced, stable-keyed, library-before-app migration registry over the Kysely model (§2.4, §6.5) — Task 5 ✅. WorkflowSpec on the contract (§10.10) — Task 4 ✅.

**2. Placeholder scan:** No TBD/TODO. Every code step is complete; every run step has command + expected result.

**3. Type/name consistency:** `BindingSpec`/`BindingType`/`VerificationStrategy`/`AuthContext`/`CapabilityManifest` are Zod objects whose const+type share names (rule honored). `Capability`, `PithyVars`, `PithyHonoEnv`, `PithyMiddleware`, `WorkflowSpec`, `defineCapability`, `createMigrationRegistry`, `NamespacedMigrations` are referenced consistently. `PithyVars` is deliberately minimal here (`auth` only) and is **extended in plan 3** (adds `db`, `kv`) — noted inline so the executor expects the modify. `migrationOrder` on `Capability` corresponds to `NamespacedMigrations.order` consumed by the registry; createBackend (plan 3) bridges them.

**Cross-plan note:** `kysely` is added here; `kysely-d1` + `@cloudflare/workers-types` arrive in plan 3 (createBackend) where a real D1 dialect/Worker runtime is needed.
