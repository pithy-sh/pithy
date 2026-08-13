// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { DatabaseSpecMap } from "@pithy-sh/core/src/data/databases";
import { workflowBindings } from "@pithy-sh/core/src/workflow/bindings";
import type { EmailCapability } from "@pithy-sh/email/src/capability";
import { isEmailCapability } from "@pithy-sh/email/src/capability";
import type { Migration } from "kysely/migration";
import { TestersConfig, type TestersConfigInput } from "./config/config";
import { testersTables } from "./data/tables";
import { testersAdminRoutes } from "./http/guards";
import { registerTestersRoutes } from "./http/routes";
import { testers_0001_cohorts } from "./migrations/0001_cohorts";
import type { EnqueueNudge } from "./nudge/send";
import { testersExampleSeed } from "./seeds/example";
import { PACKAGE_VERSION } from "./version.generated";
import { testersWorkflows } from "./workflows/specs";

/**
 * The testers capability: the roster, the invitations, and the fourteen-day clock.
 *
 * Composes into a Worker like any other capability. Its one hard dependency is `email` — an invitation
 * that cannot be sent is not a testing programme. `@pithy-sh/auth` is an **optional peer**: with it, testers who sign in
 * become observable and the early-warning signal works; without it every tester resolves as
 * unobservable, the forecast widens its band to say so, and everything else still runs.
 */

/**
 * Where testers' migrations sort in the app database. Unique per database; the registry composes keys
 * like `1200_testers_0001_cohorts`. Sits after the control-plane seam (1100), and was `NEXT_FREE_ORDER`
 * when it was taken — see `packages/cli/src/migrations/orders.test.ts`, the only place an order is
 * allocated.
 */
export const TESTERS_MIGRATION_ORDER = 1300;

/** The database name every capability sharing the app D1 coordinates on. `DB` is the binding. */
const TESTERS_DATABASE_NAME = "app" as const;

/** The options `testers()` takes: the config's input side. */
export type TestersOptions = TestersConfigInput;

/** The testers capability, with its resolved config attached for tooling to read. */
export interface TestersCapability
  extends Capability<DatabaseSpecMap, Record<never, never>, "testers", typeof testersWorkflows> {
  /** The resolved configuration. */
  testersConfig: TestersConfig;
}

/** Whether a composed capability is the testers capability — carries its resolved config. */
export function isTestersCapability(capability: Capability): capability is TestersCapability {
  return capability.name === "testers" && "testersConfig" in capability;
}

/** Compose the testers capability. */
export function testers(options: TestersOptions = {}): TestersCapability {
  // Parsed at assembly rather than lazily: a target larger than the roster cap, or an opt-in link that
  // expires before the window it belongs to closes, fails on deploy instead of on the day a tester
  // clicks a link that no longer works.
  const resolved = TestersConfig.parse(options);

  const migrations: Record<string, Migration> = { "0001_cohorts": testers_0001_cohorts };

  /**
   * The email seam, filled by `compose`.
   *
   * Held in a mutable slot rather than passed in because `compose` runs after the factory: the routes
   * are registered at assembly and need a way to reach an enqueue that does not exist yet.
   */
  const wiring: { enqueue: EmailCapability["enqueue"] | undefined } = { enqueue: undefined };

  const requiredBindings: BindingSpecInput[] = [
    // The app database — all four pithy_testers_* tables live here, alongside the pithy_auth_* tables
    // the activity reader joins against.
    { type: "d1", name: "DB" },
    // The daily pass's Workflow binding, derived from the spec rather than written again, so a binding
    // rename cannot leave the two disagreeing. Optional because the binding exists only once
    // `pithy testers provision` has deployed the host, and an unprovisioned project must still be able
    // to invite testers, accept confirmations, and read its cohorts.
    ...workflowBindings(testersWorkflows),
  ];

  const capability = defineCapability({
    name: "testers",
    // The package version this capability ships at, stamped by `scripts/stampVersions.ts` — a Worker
    // cannot read its own package.json. Reported per capability by the control-plane manifest.
    version: PACKAGE_VERSION,
    // Email is the one hard dependency: a capability whose whole job is inviting people cannot ship
    // with "and you supply the delivery". Secrets is deliberately NOT one — the confirmation token is a
    // random value on the member row rather than a signature, so nothing here reads a secret, and
    // `pithy testers invite` can build a working invitation against any environment.
    dependsOn: ["email"],
    config: TestersConfig,
    workflows: testersWorkflows,
    compose: ({ capabilities }) => {
      const email = capabilities.find(isEmailCapability);
      // `dependsOn` already fails assembly without it; this narrows the type and gives a message
      // naming what testers actually wanted it for.
      if (email) wiring.enqueue = email.enqueue;
    },
    requiredBindings,
    databases: {
      [TESTERS_DATABASE_NAME]: {
        binding: "DB",
        tables: testersTables(),
        migrationOrder: TESTERS_MIGRATION_ORDER,
        migrations,
      },
    },
    // Built from the resolved `basePath`, never the default: an adopter who mounts this at `/beta` gets
    // a manifest naming their paths, where a client assuming the default would 404.
    adminRoutes: testersAdminRoutes(resolved.basePath),
    routes: registerTestersRoutes({
      config: resolved,
      enqueue: (env) => {
        const enqueue = wiring.enqueue;
        if (!enqueue) return undefined;
        // The email capability owns the `DB` and `EMAIL_SENDER` bindings and the from-identity; testers
        // passes only the request env and the high-level input, and never names an email binding itself.
        return ((input) => enqueue(env as never, input)) as EnqueueNudge;
      },
    }),
    seeds: [testersExampleSeed],
  });

  return Object.assign(capability, { testersConfig: resolved });
}
