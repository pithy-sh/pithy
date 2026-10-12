// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { EnvironmentMigrations } from "./environmentMigrations";
import {
  capabilityReachFix,
  DoctorFix,
  docsConnectFix,
  healthWithFixes,
  migrationFix,
  prerequisiteFix,
  secretBindingFix,
  strandedTurnstileFix,
  unrenderedTurnstileFix,
} from "./findingFixes";
import type { ProjectHealth, WorkerHealth } from "./health";
import type { MissingSecretBinding } from "./secretBindings";

/**
 * **Each finding's `fix`, decided from its fields (#697).** One builder per kind of finding, each held here
 * to every state it answers: the command where one rights the finding, `null` where the remedy is an edit, a
 * person's step, or something nothing established. That every `fix` they produce is a real command with
 * declared flags is `failures.test.ts`'s, which runs each one a rendered report carries.
 */

const read = (pending: number, undeclared: { database: string; binding: string; name: string }[] = []) => ({
  state: "read" as const,
  pending,
  undeclared,
});

describe("migrationFix", () => {
  const checked = (env: string, ledger: Extract<EnvironmentMigrations, { state: "checked" }>["ledger"]) =>
    ({ env, state: "checked", ledger }) as const;

  test("pending migrations, in dev or deployed, production included, name migrate for that environment", () => {
    expect(migrationFix(checked("dev", read(2)), [])).toBe("pithy migrate --env dev");
    expect(migrationFix(checked("staging", read(1)), [])).toBe("pithy migrate --env staging");
    expect(migrationFix(checked("prod", read(3)), ["prod"])).toBe("pithy migrate --env prod");
  });

  test("a ledger read in part names migrate for what it counted, and nothing when it counted none", () => {
    const partial = (pending: number) =>
      checked("staging", {
        state: "partial",
        counted: { pending, undeclared: [] },
        unreadable: [{ database: "app", binding: "DB" }],
      });
    expect(migrationFix(partial(1), [])).toBe("pithy migrate --env staging");
    expect(migrationFix(partial(0), [])).toBeNull();
  });

  test("nothing pending, only an undeclared migration, or a ledger nobody read, names nothing", () => {
    expect(migrationFix(checked("staging", read(0)), [])).toBeNull();
    expect(migrationFix(checked("dev", read(0, [{ database: "app", binding: "DB", name: "9_gone" }])), [])).toBeNull();
    expect(migrationFix(checked("staging", { state: "unavailable" }), [])).toBeNull();
  });

  test("an environment with no database names its provision, and none where the provision is a person's", () => {
    const unprovisioned = (env: string): EnvironmentMigrations => ({
      env,
      state: "not-provisioned",
      unprovisioned: [{ database: "app", binding: "DB" }],
    });
    expect(migrationFix(unprovisioned("staging"), [])).toBe("pithy provision --env staging --yes");
    expect(migrationFix(unprovisioned("prod"), [])).toBeNull();
    expect(migrationFix(unprovisioned("live"), ["live"])).toBeNull();
  });

  test("a config that would not compose, or a read that was skipped, established nothing to fix", () => {
    expect(migrationFix({ env: "staging", state: "not-composed" }, [])).toBeNull();
    expect(migrationFix({ env: "staging", state: "skipped", reason: "offline" }, [])).toBeNull();
  });
});

describe("secretBindingFix", () => {
  const missing = (overrides: Partial<MissingSecretBinding>): MissingSecretBinding => ({
    worker: "api",
    env: "staging",
    secret: "STRIPE_KEY",
    binding: "STRIPE_KEY",
    provisionable: false,
    scope: "environment",
    entry: "acme-staging-stripe-key",
    ...overrides,
  });

  test("a value the kit composes is the provision, which mints it and writes the stanza", () => {
    expect(secretBindingFix(missing({ provisionable: true }))).toBe("pithy secrets provision");
  });

  test("a value only the operator has is supplied first, per environment or once for a global one", () => {
    expect(secretBindingFix(missing({}))).toBe("pithy secrets create STRIPE_KEY --env staging");
    expect(secretBindingFix(missing({ scope: "global" }))).toBe("pithy secrets create STRIPE_KEY");
  });
});

describe("the Turnstile fixes", () => {
  test("a blank sitekey in an environment provision writes is its to fill", () => {
    expect(unrenderedTurnstileFix({ worker: "web", environment: "staging", slot: true })).toBe(
      "pithy turnstile provision --worker web",
    );
  });

  test("a feature's blank and an environment no sitekey reaches are not", () => {
    expect(unrenderedTurnstileFix({ worker: "web", environment: "feature", slot: true })).toBeNull();
    expect(unrenderedTurnstileFix({ worker: "web", environment: "qa", slot: false })).toBeNull();
  });

  test("a stranded var names the provision that removes it, and none where nothing does", () => {
    const stranded = { worker: "web", name: "TURNSTILE_SITEKEY_STAGING", environment: "staging", file: "/p/w.jsonc" };
    expect(strandedTurnstileFix({ ...stranded, removedBy: "web" })).toBe("pithy turnstile provision --worker web");
    expect(strandedTurnstileFix({ ...stranded, worker: null, removedBy: null })).toBeNull();
  });
});

describe("the rest", () => {
  test("an unconnected AI client names the connect for its own id", () => {
    expect(docsConnectFix("cursor")).toBe("pithy docs connect --client cursor");
  });

  /**
   * **A missing peer's own peers may be missing too, and the add must compose them or refuse (#697).** `testers`
   * declares `email`, and `email` declares `secrets`; a Worker composing `testers` alone has one finding — the
   * email — and `pithy add email` with nobody to ask refuses `input/required` over the secrets. The flag composes
   * only what is missing, so it is right whether or not there is any.
   */
  test("a missing prerequisite names an add that composes what that peer needs as well", () => {
    expect(prerequisiteFix("api", "email")).toBe("pithy add email --worker api --with-prerequisites");
  });

  test("a capability installed nowhere names add for the first Worker composing it, and none with no Worker", () => {
    expect(capabilityReachFix({ capability: "email", workers: ["api", "web"] })).toBe("pithy add email --worker api");
    expect(capabilityReachFix({ capability: "email", workers: [] })).toBeNull();
  });

  test("the schema takes a command or null, and refuses an empty string", () => {
    expect(DoctorFix.parse(null)).toBeNull();
    expect(DoctorFix.parse("pithy seed")).toBe("pithy seed");
    expect(DoctorFix.safeParse("").success).toBe(false);
  });
});

describe("healthWithFixes", () => {
  const worker = {
    state: "checked",
    worker: "api",
    ok: false,
    config: { ok: false, drift: [{ capability: "media", keys: ["bucket"] }] },
    bindings: {
      ok: false,
      missing: [{ name: "MEDIA", type: "r2", envs: ["staging"] }],
      missingExports: [],
      declinedBindings: { state: "read", declines: [] },
      generatedValues: { state: "read", drift: [], stalePins: [] },
    },
    migrations: {
      ok: true,
      environments: [
        { env: "dev", state: "checked", ledger: read(0) },
        { env: "staging", state: "checked", ledger: read(2) },
        { env: "prod", state: "not-provisioned", unprovisioned: [{ database: "app", binding: "DB" }] },
      ],
    },
    entitlements: { ok: true, gap: { state: "read", gates: [] } },
    prerequisites: { ok: false, missing: [{ capability: "auth", requires: "email" }] },
  } as WorkerHealth;
  const health: ProjectHealth = {
    ok: false,
    workers: [worker, { state: "unavailable", worker: "web" }],
    manifests: { ok: false, faults: [{ package: "@pithy-sh/audit", reason: "Unexpected token." }] },
    bindingScope: { ok: true, partial: false, split: [], divergent: [] },
    capabilityReach: {
      ok: false,
      reachable: [],
      unreachable: [{ capability: "email", package: "@pithy-sh/email", workers: ["api"] }],
      split: [],
    },
  };

  /** A finding list's `fix`es. */
  type Fixes = { fix: string | null }[];
  const projected = healthWithFixes(health, []) as {
    workers: [
      {
        prerequisites: { missing: Fixes };
        config: { drift: Fixes };
        bindings: { missing: Fixes };
        migrations: { environments: ({ env: string } & Fixes[number])[] };
      },
      unknown,
    ];
    manifests: { faults: Fixes };
    capabilityReach: { unreachable: Fixes };
  };
  const [api, web] = projected.workers;

  test("each Worker finding carries the command the exit's own entry names", () => {
    expect(api.prerequisites.missing.map((entry) => entry.fix)).toEqual([
      "pithy add email --worker api --with-prerequisites",
    ]);
    expect(api.config.drift.map((entry) => entry.fix)).toEqual(["pithy upgrade --worker api"]);
    expect(api.bindings.missing.map((entry) => entry.fix)).toEqual(["pithy upgrade --worker api"]);
  });

  test("every environment's migrations carry theirs, the deployed ones that never gate included", () => {
    expect(api.migrations.environments.map(({ env, fix }) => ({ env, fix }))).toEqual([
      { env: "dev", fix: null },
      { env: "staging", fix: "pithy migrate --env staging" },
      { env: "prod", fix: null },
    ]);
  });

  test("the project-wide findings carry theirs, and a Worker nobody checked is passed through", () => {
    expect(projected.manifests.faults.map((fault) => fault.fix)).toEqual([null]);
    expect(projected.capabilityReach.unreachable.map((entry) => entry.fix)).toEqual(["pithy add email --worker api"]);
    expect(web).toEqual({ state: "unavailable", worker: "web" });
  });

  test("the health it was handed is not changed: upgrade reads the same object", () => {
    expect(Object.hasOwn(health.manifests.faults[0] ?? {}, "fix")).toBe(false);
    if (worker.state !== "checked") throw new Error("planted: the Worker is checked");
    expect(Object.hasOwn(worker.migrations.environments[1] ?? {}, "fix")).toBe(false);
  });
});

describe("healthWithFixes, on the findings whose remedy is an edit or a decision", () => {
  const checked = (bindings: Partial<Extract<WorkerHealth, { state: "checked" }>["bindings"]>) =>
    ({
      state: "checked",
      worker: "api",
      ok: false,
      config: { ok: true, drift: [] },
      bindings: {
        ok: false,
        missing: [],
        missingExports: [],
        declinedBindings: { state: "read", declines: [] },
        generatedValues: { state: "read", drift: [], stalePins: [] },
        ...bindings,
      },
      migrations: { ok: true, environments: [] },
      entitlements: { ok: true, gap: { state: "read", gates: [] } },
      prerequisites: { ok: true, missing: [] },
    }) as WorkerHealth;
  const healthOf = (workers: WorkerHealth[]): ProjectHealth => ({
    ok: false,
    workers,
    manifests: { ok: true, faults: [] },
    bindingScope: { ok: true, partial: false, split: [], divergent: [] },
    capabilityReach: {
      ok: true,
      reachable: ["auth"],
      unreachable: [],
      split: [
        {
          capability: "auth",
          package: "@pithy-sh/auth",
          at: [
            { worker: "api", version: "0.9.0" },
            { worker: "web", version: "0.8.0" },
          ],
        },
      ],
    },
  });
  type Bindings = {
    declinedBindings: { state: string; declines?: { name: string; fix: unknown }[]; problem?: string };
    generatedValues: { state: string; drift?: { fix: unknown }[]; stalePins?: { fix: unknown }[]; problem?: string };
  };
  const bindingsOf = (health: ProjectHealth) =>
    (healthWithFixes(health, []) as { workers: { bindings: Bindings }[] }).workers[0]?.bindings;

  test("each decline, each differing generated value and each stale pin carries fix: null", () => {
    const bindings = bindingsOf(
      healthOf([
        checked({
          declinedBindings: {
            state: "read",
            declines: [
              { state: "required", name: "DB", type: "d1", capability: "auth", reason: "None." },
              { state: "unrecognized", name: "OLD", reason: "Gone." },
            ],
          },
          generatedValues: {
            state: "read",
            drift: [
              {
                name: "LIMITER",
                type: "ratelimit",
                field: "namespace_id",
                expected: "1",
                actual: "2",
                envs: ["staging"],
                pinnedReason: null,
              },
            ],
            stalePins: [{ name: "SESSIONS", reason: "Tuned." }],
          },
        }),
      ]),
    );
    expect(bindings?.declinedBindings.declines?.map(({ name, fix }) => ({ name, fix }))).toEqual([
      { name: "DB", fix: null },
      { name: "OLD", fix: null },
    ]);
    expect(bindings?.generatedValues.drift?.map((entry) => entry.fix)).toEqual([null]);
    expect(bindings?.generatedValues.stalePins?.map((entry) => entry.fix)).toEqual([null]);
  });

  test("a declaration that would not read is passed through: its problem is the edit, and it has no entries", () => {
    const declinedBindings = { state: "invalid" as const, problem: "Not an object." };
    const generatedValues = { state: "invalid" as const, problem: "Not an array." };
    const bindings = bindingsOf(healthOf([checked({ declinedBindings, generatedValues })]));
    expect(bindings?.declinedBindings).toEqual(declinedBindings);
    expect(bindings?.generatedValues).toEqual(generatedValues);
  });

  test("a capability its Workers resolve at two versions carries fix: null", () => {
    const projected = healthWithFixes(healthOf([]), []) as { capabilityReach: { split: { fix: unknown }[] } };
    expect(projected.capabilityReach.split.map((entry) => entry.fix)).toEqual([null]);
  });
});
