// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { describe, expect, test } from "vitest";
import { TestersAuditActions } from "./audit/actions";
import { isTestersCapability, TESTERS_MIGRATION_ORDER, testers } from "./capability";
import { testersTables } from "./data/tables";
import { TESTERS_CONTROL_PLANE_SCOPES } from "./http/guards";
import { testersWorkflows } from "./workflows/specs";

const BASE = { baseUrl: "https://api.example.test" };

describe("capability identity", () => {
  test("one name is the migration namespace, the table prefix, the error domain, and the workflow key", () => {
    // `testers` is a single string appearing in five places; if any of them drifts, the composed
    // migration key changes and Kysely re-runs applied migrations on an adopter's database.
    const capability = testers(BASE);
    expect(capability.name).toBe("testers");
    for (const table of Object.keys(testersTables())) {
      expect(table.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)).toMatch(/^pithy_testers_/);
    }
    for (const action of Object.values(TestersAuditActions)) expect(action.startsWith("testers/")).toBe(true);
    for (const scope of TESTERS_CONTROL_PLANE_SCOPES) expect(scope.startsWith("testers:")).toBe(true);
  });

  test("the type guard narrows to the resolved config", () => {
    const capability = testers({ ...BASE, basePath: "/beta" });
    expect(isTestersCapability(capability)).toBe(true);
    expect(capability.testersConfig.basePath).toBe("/beta");
    expect(isTestersCapability({ name: "testers", requiredBindings: [] })).toBe(false);
  });
});

describe("bindings and dependencies", () => {
  test("declares the app database and the daily pass's workflow binding, and nothing else", () => {
    expect(testers(BASE).requiredBindings).toEqual([
      { type: "d1", name: "DB", optional: false },
      { type: "workflow", name: "TESTERS_DAILY", optional: true },
    ]);
  });

  test("the workflow binding is derived from the spec rather than written twice", () => {
    // One declaration, so a binding rename cannot leave the two disagreeing.
    const binding = testers(BASE).requiredBindings.find((entry) => entry.type === "workflow");
    expect(binding?.name).toBe(testersWorkflows.daily.binding);
    expect(binding?.optional).toBe(testersWorkflows.daily.optional);
  });

  test("the workflow binding is optional, so an unprovisioned project still boots", () => {
    // The binding exists only after `pithy testers provision`. A project that has not run it must still
    // be able to invite testers and accept confirmations — it simply gets no snapshots, and therefore
    // no trend.
    expect(testers(BASE).requiredBindings.find((b) => b.type === "workflow")?.optional).toBe(true);
  });

  test("depends on email alone, and not on secrets", () => {
    // Email: a capability whose job is inviting people cannot ship "and you supply delivery".
    // Secrets deliberately not: the confirmation token is a random value on the member row rather than
    // a signature, so nothing here reads a secret — which is what lets `pithy testers invite` build a
    // working invitation against any environment rather than only against local dev.
    expect(testers(BASE).dependsOn).toEqual(["email"]);
  });

  test("does not depend on auth — a project with no sign-in still runs cohorts", () => {
    // Without auth every tester is unobservable, the forecast widens its band to say so, and the clock
    // still works. Making auth a hard dependency would exclude exactly the apps that need this most.
    expect(testers(BASE).dependsOn).not.toContain("auth");
  });
});

describe("migrations", () => {
  test("declares the allocated order and composes without collision", () => {
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: "testers",
        order: TESTERS_MIGRATION_ORDER,
        migrations: testers(BASE).databases?.app?.migrations ?? {},
      },
    ]);
    expect(Object.keys(registry)).toEqual(["app"]);
  });

  test("the migration order is the one allocated in the CLI's orders table", () => {
    // Never grepped for, never renumbered. Renumbering a released capability renames its composed keys,
    // which makes Kysely read applied migrations as unapplied and re-run them on an adopter's database.
    //
    // This one moved from 1200 to 1300 once, before release: `@pithy-sh/support` landed on main having
    // taken 1200 from the same `NEXT_FREE_ORDER`, and because both branches bumped the constant to the
    // same value git merged them without a conflict — so the collision was invisible until the two
    // capabilities' orders were compared directly. `pithy migrate` throws `duplicate migration order`
    // for any project composing both. Support shipped first, so it keeps 1200. Nothing had been
    // released here, which is the only reason moving was safe.
    expect(TESTERS_MIGRATION_ORDER).toBe(1300);
  });

  test("registers its migration under the stable local key", () => {
    expect(Object.keys(testers(BASE).databases?.app?.migrations ?? {})).toEqual(["0001_cohorts"]);
  });
});

describe("workflows", () => {
  test("declares exactly one job, on a daily cron", () => {
    expect(Object.keys(testersWorkflows)).toEqual(["daily"]);
    expect(testersWorkflows.daily.schedule).toBe("0 5 * * *");
  });

  test("the cron is offset from the other hosts', so four do not contend for one minute", () => {
    // storage 03:00, secrets 03:00, payments 04:00. Five is the next free hour.
    expect(testersWorkflows.daily.schedule).not.toBe("0 3 * * *");
    expect(testersWorkflows.daily.schedule).not.toBe("0 4 * * *");
  });

  test("every parameter is optional, because a cron passes none of them", () => {
    // A schema demanding a field could never run on its own schedule — `createEntrypoint` dispatches a
    // scheduled job with `{}`.
    expect(() => testersWorkflows.daily.params.parse({})).not.toThrow();
  });
});

describe("configuration is validated at assembly", () => {
  test("a target larger than the roster cap fails on deploy rather than at runtime", () => {
    expect(() => testers({ ...BASE, cohortDefaults: { targetSize: 200, maxRosterSize: 100 } })).toThrow();
  });

  test("a link that expires before the window closes fails on deploy", () => {
    // The symptom otherwise is an opt-in route that 400s for exactly the people you most need, live.
    expect(() => testers({ ...BASE, optInLinkTtlDays: 7, cohortDefaults: { windowDays: 14 } })).toThrow();
  });

  test("an active window as wide as the test window fails on deploy", () => {
    // Every tester would read as active for the whole window and the early-warning signal would be dead.
    expect(() => testers({ ...BASE, activeWithinDays: 14, cohortDefaults: { windowDays: 14 } })).toThrow();
  });

  test("the shipped defaults are Google Play's own numbers", () => {
    const config = testers(BASE).testersConfig;
    expect(config.cohortDefaults.targetSize).toBe(12);
    expect(config.cohortDefaults.windowDays).toBe(14);
    expect(config.cohortDefaults.targetPlatform).toBe("android");
  });

  test("the reset policy defaults to the pessimistic reading", () => {
    // Google documents neither behaviour. Being told day fourteen while actually on day three is the
    // expensive mistake; the reverse costs a shrug.
    expect(testers(BASE).testersConfig.cohortDefaults.resetPolicy).toBe("reset");
  });
});

describe("the manifest matches the capability", () => {
  test("declares the same bindings, peers, namespace, and name", async () => {
    const manifest = (await import("../pithy.manifest.json", { with: { type: "json" } })).default;
    const capability = testers(BASE);
    expect(manifest.name).toBe(capability.name);
    expect(manifest.migrationNamespace).toBe(capability.name);
    expect(manifest.package).toBe("@pithy-sh/testers");
    expect([...manifest.peerCapabilities].sort()).toEqual([...(capability.dependsOn ?? [])].sort());
    expect(manifest.requiredBindings.map((b) => `${b.type}:${b.name}`).sort()).toEqual(
      capability.requiredBindings.map((b) => `${b.type}:${b.name}`).sort(),
    );
  });

  test("the scaffold tells an adopter to paste the store link, which nothing else would", () => {
    // The one piece of setup no default can supply and no API can derive. Without it the second email
    // never goes out, and a tester who said yes waits forever for a link nobody sent.
    return import("../pithy.manifest.json", { with: { type: "json" } }).then(({ default: manifest }) => {
      expect(manifest.scaffold.join(" ")).toContain("play.google.com/apps/testing");
      expect(manifest.scaffold.join(" ")).toContain("--store-url");
    });
  });

  test("the rationale states plainly that Pithy cannot read Google's count", () => {
    return import("../pithy.manifest.json", { with: { type: "json" } }).then(({ default: manifest }) => {
      expect(manifest.whenToEnable).toMatch(/no API exposes it/i);
      expect(manifest.whenToEnable).toMatch(/estimate/i);
    });
  });
});
