// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readClock } from "@pithy-sh/testers/src/clock/replay";
import { TesterPlatform, TestersConfig } from "@pithy-sh/testers/src/config/config";
import type { TestersCohort } from "@pithy-sh/testers/src/data/cohort";
import type { TestersMember } from "@pithy-sh/testers/src/data/member";
import { CohortView } from "@pithy-sh/testers/src/http/responses";
import { toCohortView } from "@pithy-sh/testers/src/http/view";
import type { CohortReading } from "@pithy-sh/testers/src/roster/read";
import type { CohortPassResult } from "@pithy-sh/testers/src/workflows/daily";
import { afterEach, describe, expect, test, vi } from "vitest";
import { contractAt, expectConforms, runCaptured } from "../test-utils/payloadContract";

/**
 * **What the roster commands write under `--json`, held to the schemas `pithy schema testers` publishes (#697).**
 *
 * The package is the project's, so the CLI loads it at run time and cannot import its schemas for its own. The
 * stand-in below is therefore built from the package's **real** pieces wherever a shape comes from one — the
 * clock replay, the cohort view, the config — and its database reads hand back rows typed as the package types
 * them. What runs is the real command: the driver it opens, the projections it writes, the line.
 */

const CREATED = new Date("2026-06-01T00:00:00.000Z");
const NOW = new Date("2026-06-10T12:00:00.000Z");
const CONFIG = TestersConfig.parse({ baseUrl: "https://api.example.test" });

const COHORT: TestersCohort = {
  id: "c-1",
  name: "closed-test",
  targetPlatform: "android",
  targetSize: 2,
  windowDays: 14,
  maxRosterSize: 10,
  storeOptInUrl: "https://play.google.com/apps/testing/com.example.app",
  resetPolicy: "reset",
  closedAt: null,
  createdAt: CREATED,
  updatedAt: CREATED,
} as TestersCohort;

const ADA: TestersMember = {
  id: "m-ada",
  cohortId: "c-1",
  email: "ada@example.test",
  name: null,
  optInToken: "ada-token",
  state: "accepted",
  invitedAt: CREATED,
  acceptedAt: CREATED,
  optedInAt: null,
  lapsedAt: null,
  lastInvitedAt: CREATED,
  lastNudgedAt: null,
  nudgeCount: 0,
  unreachable: false,
  createdAt: CREATED,
  updatedAt: CREATED,
} as TestersMember;

/** A reading the package's own clock replayed, with one tester and no events. */
const READING: CohortReading = {
  cohort: COHORT,
  clock: readClock({ createdAt: CREATED, targetSize: 2, windowDays: 14, resetPolicy: "reset" }, [], NOW),
  readings: [
    {
      member: ADA,
      activity: {
        email: ADA.email,
        userId: null,
        observability: "unobservable",
        state: "never_linked",
        lastAuthenticatedAt: null,
        sessionsInWindow: 0,
        devices: [],
      },
    },
  ],
  events: [],
} as unknown as CohortReading;

const PASS: CohortPassResult = {
  cohortId: "c-1",
  snapshotOn: "2026-06-10",
  nudged: { confirm: 1, store: 0, inactive: 0, closing: 0 },
  estimatedOptedInCount: 0,
  estimatedHeldDays: 0,
  trendDirection: "unknown",
  pruned: 0,
  nudgesSkipped: "no_base_url",
};

vi.mock("@pithy-sh/cloudflare/src/env/devVars", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/cloudflare/src/env/devVars")>()),
  loadCloudflareEnv: () => ({}),
}));
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: "acme" }),
  projectCloudflareAccount: async () => null,
}));
vi.mock("../project/workerScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/workerScope")>()),
  resolveWorkers: async () => [
    { name: "api", dir: "/does/not/exist", capabilities: [{ name: "testers", testersConfig: CONFIG }] },
  ],
}));
vi.mock("../cloudflare/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/config")>()),
  cloudflareEnv: () => ({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token" }),
  cloudflareAccountConfirmation: () => ({ source: "test" }),
}));
vi.mock("../cloudflare/clients", () => ({ cloudflareClients: async () => ({}) }));
vi.mock("../audit/cliAudit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audit/cliAudit")>()),
  createProjectCliAudit: async () => async () => {},
}));
vi.mock("../capabilities/testersProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/testersProvisioner")>()),
  CloudflareTestersProvisioner: class {},
  loadTestersProvisioning: async () => ({
    deprovisionTesters: async (_provisioner: unknown, project: string, environments: readonly string[]) =>
      environments.map((env) => ({ env, worker: `${project}-${env}-testers` })),
  }),
}));
vi.mock("../seed/drivers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../seed/drivers")>()),
  openSeedDriver: async () => ({ d1: () => ({}), dispose: async () => {} }),
}));
vi.mock("../capabilities/testersLoader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/testersLoader")>()),
  loadTesters: async () => ({
    isTestersCapability: (capability: { name: string }) => capability.name === "testers",
    testersDatabase: () => ({}),
    createCohort: async () => COHORT,
    closeCohort: async () => ({ ...COHORT, closedAt: NOW, updatedAt: NOW }),
    listCohorts: async () => [COHORT],
    resolveCohortRef: async () => COHORT,
    readCohort: async () => READING,
    listSnapshots: async () => [],
    toCohortView,
    inviteMember: async () => ({ member: ADA, created: true }),
    listMembers: async () => [ADA],
    findMemberByEmail: async () => ADA,
    removeMember: async () => ({ ...ADA, state: "removed", lapsedAt: NOW }),
    runDailyPass: async () => [PASS],
    runCohortPass: async () => PASS,
    optOutUrl: () => "https://api.example.test/out",
    confirmUrl: () => "https://api.example.test/confirm",
    optInUrl: () => "https://api.example.test/in",
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pithy testers --json conforms to its published payloads", () => {
  test("create and close write the cohort row", async () => {
    await expectConforms("testers create", await runCaptured("testers create", ["closed-test", "--json"]));
    await expectConforms("testers close", await runCaptured("testers close", ["closed-test", "--json"]));
  });

  test("list, invite, pending and remove", async () => {
    await expectConforms("testers list", await runCaptured("testers list", ["--json"]));
    await expectConforms(
      "testers invite",
      await runCaptured("testers invite", ["closed-test", "--email", "ada@example.test", "--json"]),
    );
    await expectConforms("testers pending", await runCaptured("testers pending", ["closed-test", "--json"]));
    await expectConforms(
      "testers remove",
      await runCaptured("testers remove", ["closed-test", "--email", "ada@example.test", "--json"]),
    );
  });

  test("roster and status write the package's own cohort view", async () => {
    await expectConforms("testers roster", await runCaptured("testers roster", ["closed-test", "--json"]));
    await expectConforms("testers status", await runCaptured("testers status", ["closed-test", "--json"]));
  });

  test("deprovision writes one result per environment", async () => {
    await expectConforms("testers deprovision", await runCaptured("testers deprovision", ["--json"]));
  });

  test("run writes one result per cohort", async () => {
    await expectConforms("testers run", await runCaptured("testers run", ["--skip-nudges", "--json"]));
    await expectConforms("testers run", await runCaptured("testers run", ["--cohort", "closed-test", "--json"]));
  });

  /**
   * The CLI's view schema is a projection of the package's, typed where a script reads and open beyond: a
   * view the package's own schema accepts is one the CLI's must too, or `pithy schema` would describe a
   * line the command does not write.
   */
  test("the view the package's own schema accepts is the view the line carries", () => {
    const view = toCohortView(READING, CONFIG, { includeMembers: true, snapshots: [], latest: undefined }, NOW);
    expect(CohortView.safeParse(JSON.parse(JSON.stringify(view))).success).toBe(true);
  });
});

/**
 * `pithy schema` publishes the platforms `--platform` takes, and the cohort the command writes is parsed by
 * the testers package's own enum. A shipped module cannot import that package, so the two are held equal here.
 */
describe("pithy testers create --platform", () => {
  test("publishes exactly the platforms the testers package accepts", async () => {
    expect((await contractAt("testers create")).flags?.platform?.enum).toEqual(TesterPlatform.options);
  });
});
