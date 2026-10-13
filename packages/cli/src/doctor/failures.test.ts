// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { ReconcilePlan } from "../capabilities/reconcile";
import { buildDoctorReport, type DoctorReport, doctorExitCode, renderDoctorJson } from "../commands/doctor";
import { publishedPayload } from "../contract/commandContract";
import { buildDocsCatalog } from "../docs/catalog";
import { formatJsonLine } from "../terminal/output";
import { cleanPlanFor, doctorHarness, ledgerStubPer, planStub } from "../test-utils/doctorHarness";
import { contractAt, expectConforms } from "../test-utils/payloadContract";
import { dirOf } from "../test-utils/workerDir";
import { type DoctorFailure, DoctorFailures, doctorFailures } from "./failures";
import type { ProjectHealth } from "./health";

/**
 * **Every failing `pithy doctor` check carries `fix` (#697).**
 *
 * The list is the exit gate — `doctorExitCode` is whether it is empty — so "every failing check" is a set
 * this suite can enumerate rather than one it has to trust: one report per gating state — every branch of
 * `failures.ts`, both fallbacks included — each held to its entry and its `fix`. A `fix` is a whole `pithy`
 * command run as written, or `null` where none rights the finding. `failuresOf` holds every `fix` a case
 * produces to the real command tree and its flags, and that is the only gate on them: most are templates
 * that interpolate a name, which `ci/actionLines.test.ts` cannot resolve to a command. A branch with no case
 * here is a `fix` nothing checks.
 */

const harness = doctorHarness();

/** A healthy report with one block replaced: the report as the harness builds it, every other block untouched. */
async function healthyWith(overrides: Parameters<typeof harness.healthyOptions>[0] = {}): Promise<DoctorReport> {
  return buildDoctorReport(harness.healthyOptions(overrides));
}

const catalog = await buildDocsCatalog();

/** `pithy doctor --json`'s payload as `pithy schema doctor` publishes it. */
const doctorSchema = z.toJSONSchema(publishedPayload(await contractAt("doctor")) as z.ZodType, { io: "input" });

/**
 * Why `fix` is not a command this CLI has, with flags it declares — or `null` when it is. The question
 * `ci/actionLines.test.ts` asks of every `fix:` literal in source, asked of what each case below produced,
 * which covers the commands composed from a finding's fields where the literal is a template.
 */
function unrunnable(fix: string): string | null {
  const words = fix.split(" ");
  if (words[0] !== "pithy") return `${fix}: not a pithy command`;
  const command = catalog.commands
    .filter((entry) => words.slice(1, entry.path.split(" ").length + 1).join(" ") === entry.path)
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (command === undefined) return `${fix}: no such command`;
  const stray = words.filter((word) => word.startsWith("--") && !command.flags.includes(word));
  return stray.length === 0 ? null : `${fix}: pithy ${command.path} declares no ${stray.join(", ")}`;
}

/**
 * The report's failures, after asserting what holds of every one: the exit and the list agree, `--json`
 * carries exactly this list in its published shape, and every `fix` runs as written.
 */
function failuresOf(report: DoctorReport): DoctorFailure[] {
  const failures = doctorFailures(report);
  expect(doctorExitCode(report)).toBe(failures.length > 0 ? 1 : 0);
  expect(DoctorFailures.parse(renderDoctorJson(report).failures)).toEqual(failures);
  const fixes = failures.map((failure) => failure.fix).filter((fix): fix is string => fix !== null);
  expect(fixes.map(unrunnable).filter((why) => why !== null)).toEqual([]);
  return failures;
}

/**
 * The report with part of its project health replaced. Doctor builds no seam for the manifest scan or the
 * binding-scope read, so the states only they produce are planted on a report the harness built.
 */
function withHealth(report: DoctorReport, patch: Partial<ProjectHealth>): DoctorReport {
  const project = report.project;
  if (project === null) throw new Error("planted: the harness report has no project");
  return { ...report, project: { ...project, health: { ...project.health, ok: false, ...patch } } };
}

/** The `check` and `fix` of each failure, which is what most cases are about. */
const checksAndFixes = (failures: DoctorFailure[]) => failures.map(({ check, fix }) => ({ check, fix }));

/** A plan for `api` with one thing changed. */
const plan = (overrides: Partial<ReconcilePlan>): ReconcilePlan => ({ ...cleanPlanFor("api"), ...overrides });

describe("a healthy project", () => {
  test("has no failures, exits 0, and --json says so with an empty list", async () => {
    const report = await healthyWith();
    expect(failuresOf(report)).toEqual([]);
    expect(renderDoctorJson(report).failures).toEqual([]);
  });
});

describe("each gating check is one entry, with its fix", () => {
  test("a self-administering stanza with no SELF names the provision for its environment, and none for prod", async () => {
    const report = await healthyWith({
      checkSelfBinding: async () => ({
        state: "unbound",
        declared: true,
        missing: [
          { worker: "api", env: "staging", boundTo: null, deploysAs: "acme-staging-api" },
          { worker: "api", env: "prod", boundTo: null, deploysAs: "acme-prod-api" },
        ],
      }),
    });
    expect(failuresOf(report).map(({ check, fix }) => ({ check, fix }))).toEqual([
      { check: "selfBinding", fix: "pithy provision --env staging --yes" },
      { check: "selfBinding", fix: null },
    ]);
  });

  test("an environment the project declares production gets no provision fix either", async () => {
    const report = await healthyWith({
      loadProject: async () => ({ name: "pithy-app", seed: { productionEnvironments: ["live"] } }),
      checkSelfBinding: async () => ({
        state: "unbound",
        declared: true,
        missing: [{ worker: "api", env: "live", boundTo: null, deploysAs: "acme-live-api" }],
      }),
    });
    expect(failuresOf(report).map((failure) => failure.fix)).toEqual([null]);
  });

  test("a declared origin nothing serves names the sync; an open workers.dev is an edit; no origin does not gate", async () => {
    const report = await healthyWith({
      checkOrigins: async () => ({
        state: "drifted",
        drift: [
          {
            worker: dirOf("api"),
            env: "prod",
            fault: "unserved-origin",
            origin: "https://app.acme.dev",
            source: "declaration",
          },
          { worker: dirOf("api"), env: "staging", fault: "workers-dev-open", origin: "https://staging.acme.dev" },
          { worker: dirOf("api"), env: "live", fault: "no-origin", origin: null },
        ],
      }),
    });
    expect(failuresOf(report).map(({ check, fix }) => ({ check, fix }))).toEqual([
      { check: "origins", fix: "pithy worker sync --worker api --env prod" },
      { check: "origins", fix: null },
    ]);
  });

  test("an unsynced Workflow stanza names the sync for that Worker and environment", async () => {
    const report = await healthyWith({
      checkWorkflows: async () => ({
        state: "drifted",
        drift: [
          {
            worker: dirOf("api"),
            env: "prod",
            fault: "unsynced-stanza",
            declared: { workflows: [], crons: ["0 4 * * *"] },
            bound: { workflows: [], crons: [] },
          },
        ],
      }),
    });
    expect(failuresOf(report).map((failure) => failure.fix)).toEqual(["pithy worker sync --worker api --env prod"]);
  });

  test("a support index nothing maintains names the provision for the Worker read", async () => {
    const report = await healthyWith({
      checkSupportSearchTriggers: async () => ({
        state: "findings",
        environments: [
          { env: "prod", worker: "api", directory: dirOf("api"), state: "drift", triggers: "none" },
          { env: "staging", worker: "api", directory: dirOf("api"), state: "ok" },
        ],
      }),
    });
    const failures = failuresOf(report);
    expect(failures.map((failure) => failure.fix)).toEqual(["pithy support provision --worker api"]);
    expect(failures[0]?.detail).toContain("prod:");
  });

  // The worse of the two faults: the triggers outlived their table, so every message write raises. The same
  // provision rewrites both halves.
  test("triggers with no table under them name the provision for the Worker read", async () => {
    const report = await healthyWith({
      checkSupportSearchTriggers: async () => ({
        state: "findings",
        environments: [
          { env: "staging", worker: "api", directory: dirOf("api"), state: "orphaned-triggers", triggers: "all" },
        ],
      }),
    });
    const failures = failuresOf(report);
    expect(checksAndFixes(failures)).toEqual([
      { check: "supportSearchTriggers", fix: "pithy support provision --worker api" },
    ]);
    expect(failures[0]?.detail).toMatch(/^api: /);
  });

  // The state gates on its own; answers that are none of them a fault still leave an entry, so the list is
  // never short of the exit.
  test("support search findings that name no fault still get their entry, with no fix", async () => {
    const report = await healthyWith({
      checkSupportSearchTriggers: async () => ({
        state: "findings",
        environments: [
          { env: "staging", worker: "api", directory: dirOf("api"), state: "ok" },
          { env: "prod", worker: "api", directory: dirOf("api"), state: "unreadable" },
        ],
      }),
    });
    expect(failuresOf(report)).toEqual([
      {
        check: "supportSearchTriggers",
        detail: "Support search has findings. Run pithy doctor for the lines.",
        fix: null,
      },
    ]);
  });

  // A reserved name needs a new name, which is a choice: an edit, never a command.
  test("a Worker deploying as a capability's own host Worker is an edit, so its fix is null", async () => {
    const report = await healthyWith({
      checkWorkerNames: async () => ({
        state: "drifted",
        mismatches: [],
        reserved: [{ worker: dirOf("api"), env: "prod", name: "acme-prod-mcp", capability: "mcp" }],
        convention: [],
      }),
    });
    const failures = failuresOf(report);
    expect(checksAndFixes(failures)).toEqual([{ check: "workerNames", fix: null }]);
    expect(failures[0]?.detail).toBe(
      "api in prod deploys as acme-prod-mcp — the mcp capability's own host Worker. Deploying replaces it.",
    );
  });

  test("a settings finding carries the command its capability named, and null where it named none", async () => {
    const base = {
      worker: "api",
      capability: "email",
      tier: "account",
      environment: null,
      problem: "Missing.",
    } as const;
    const report = await healthyWith({
      checkSettings: async () => ({
        state: "faults",
        account: { state: "checked", reason: null },
        checked: [{ worker: "api", capability: "email" }],
        findings: [
          {
            ...base,
            setting: "EMAIL_SUPPRESSIONS",
            action: "Run `pithy email provision`.",
            fix: "pithy email provision",
          },
          { ...base, setting: "fromAddress", action: "Set `email({ fromAddress })`." },
        ],
        unchecked: [],
      }),
    });
    expect(failuresOf(report).map(({ check, fix }) => ({ check, fix }))).toEqual([
      { check: "settings", fix: "pithy email provision" },
      { check: "settings", fix: null },
    ]);
  });

  test.each<[string, Parameters<typeof harness.healthyOptions>[0], DoctorFailure["check"]]>([
    [
      "credentials for the wrong account",
      {
        checkCloudflare: async () => ({
          state: "token_invalid",
          missing: [],
          tokenStatus: null,
          credentialSplit: null,
        }),
      },
      "cloudflare",
    ],
    [
      "a project name no namespace can carry",
      { checkProjectName: async () => ({ state: "invalid", project: "Acme App", misnamed: [] }) },
      "projectName",
    ],
    [
      "a stamp the directory contradicts",
      {
        checkWorkerNames: async () => ({
          state: "drifted",
          mismatches: [{ worker: "api", stamp: "name", declared: "old-api", expected: "acme-api", envs: [] }],
          reserved: [],
          convention: [],
        }),
      },
      "workerNames",
    ],
    [
      "a rate-limit id in the feature range",
      {
        checkFeatureRatelimitIds: async () => ({
          state: "reserved",
          findings: ["api declares namespace_id 1000000001 in env.staging."],
        }),
      },
      "featureRatelimitIds",
    ],
    [
      "a stanza the declaration does not name",
      {
        checkEnvironments: async () => ({
          state: "drifted",
          declared: ["staging", "prod"],
          drift: [{ worker: "api", env: "qa", kind: "undeclared", resources: [] }],
        }),
      },
      "environments",
    ],
    [
      "a config that throws for a declared environment",
      {
        checkEnvironmentConfigs: async () => ({
          unresolved: [{ environment: "prod", reason: "Set email({ baseUrl }) for prod." }],
        }),
      },
      "environmentConfigs",
    ],
    [
      "a dev.json that names no user",
      {
        checkDevPreferences: async () => ({
          state: "no-user",
          path: "/home/u/.config/pithy/acme/dev.json",
          user: null,
        }),
      },
      "devPreferences",
    ],
  ])("%s is an edit or a person's step, so its fix is null", async (_, overrides, check) => {
    const failures = failuresOf(await healthyWith(overrides));
    expect(failures.map((failure) => ({ check: failure.check, fix: failure.fix }))).toEqual([{ check, fix: null }]);
    expect(failures[0]?.detail).toMatch(/\.$/);
  });

  test("a config that would not load is the one failure, and no command fixes it", async () => {
    const report = await healthyWith({
      loadProject: async () => {
        throw new InternalError({ message: "Could not load pithy.config.ts.", action: "Run bun install." });
      },
    });
    expect(failuresOf(report)).toEqual([
      {
        check: "project",
        detail: "pithy.config.ts would not load. Could not load pithy.config.ts. Run bun install.",
        fix: null,
      },
    ]);
  });
});

describe("project health, one entry per failing check", () => {
  test("a missing peer names add for that Worker; drift and a missing binding name upgrade for it", async () => {
    const report = await healthyWith({
      buildPlan: planStub(
        plan({
          missingPrerequisites: [{ capability: "auth", requires: "email" }],
          perCapability: [
            {
              name: "media",
              missingConfigKeys: [{ key: "bucket", source: "default" } as never],
              missingEntryExports: ["MediaRoom"],
              missingBindings: [{ env: "staging", name: "MEDIA_BUCKET", type: "r2" }],
            },
          ],
        }),
      ),
    });
    expect(failuresOf(report).map((failure) => failure.fix)).toEqual([
      "pithy add email --worker api --with-prerequisites",
      "pithy upgrade --worker api",
      "pithy upgrade --worker api",
      "pithy upgrade --worker api",
    ]);
  });

  test("dev's pending migrations name migrate for dev; a deployed environment behind reports and does not fail", async () => {
    const report = await healthyWith({
      readLedger: ledgerStubPer({
        api: {
          dev: { state: "read", pending: 2, undeclared: [] },
          staging: { state: "read", pending: 5, undeclared: [] },
        },
      }),
    });
    expect(failuresOf(report).map(({ detail, fix }) => ({ detail, fix }))).toEqual([
      { detail: "api: 2 pending in dev.", fix: "pithy migrate --env dev" },
    ]);
  });

  test("a migration dev applied and nobody declares is a local wipe, which no fix runs", async () => {
    const report = await healthyWith({
      readLedger: ledgerStubPer({
        api: {
          dev: { state: "read", pending: 0, undeclared: [{ database: "app", binding: "DB", name: "9999_gone" }] },
        },
      }),
    });
    expect(failuresOf(report).map((failure) => failure.fix)).toEqual([null]);
  });

  test("a gated route with no provider is the adopter's choice of provider, so it names none", async () => {
    const report = await healthyWith({
      buildPlan: planStub(plan({ entitlements: { state: "read", gates: ["src/routes/pro.ts"] } })),
    });
    expect(failuresOf(report).map((failure) => failure.fix)).toEqual([null]);
  });

  // #711: the example it offers runs as written in a project with several Workers, as the text report's does.
  test("a gated route's example provider is the one the text report names, for this Worker", async () => {
    const report = await healthyWith({
      buildPlan: planStub(plan({ entitlements: { state: "read", gates: ["src/routes/pro.ts"] } })),
    });
    expect(failuresOf(report).map((failure) => failure.detail)).toEqual([
      "api: routes gate on an entitlement nothing composed resolves: src/routes/pro.ts. Compose a provider, such as `pithy add payments --worker api --with-prerequisites --set billingSubject=user` or `pithy add payments --worker api --with-prerequisites --set billingSubject=organization`.",
    ]);
  });
});

describe("project health, the branches a plan does not reach", () => {
  test("a composed capability that is not installed names add for the first Worker composing it, and none with no Worker", async () => {
    const report = await healthyWith({
      readCapabilityReach: async () => ({
        ok: false,
        reachable: [],
        unreachable: [
          { capability: "email", package: "@pithy-sh/email", workers: [dirOf("api"), dirOf("web")] },
          { capability: "media", package: "@pithy-sh/media", workers: [] },
        ],
        split: [],
      }),
    });
    const failures = failuresOf(report);
    expect(checksAndFixes(failures)).toEqual([
      { check: "project", fix: "pithy add email --worker api --with-prerequisites" },
      { check: "project", fix: null },
    ]);
    expect(failures[0]?.detail).toBe("email is composed by api, web, and @pithy-sh/email is not installed.");
  });

  test("a manifest nobody can use is someone else's package, so no command is named", async () => {
    const report = withHealth(await healthyWith(), {
      manifests: { ok: false, faults: [{ package: "@pithy-sh/audit", reason: "Unexpected token." }] },
    });
    expect(failuresOf(report)).toEqual([
      {
        check: "project",
        detail: "@pithy-sh/audit has a pithy.manifest.json that cannot be used: Unexpected token.",
        fix: null,
      },
    ]);
  });

  test("a split project-global binding is a carry before a provision, and its dev stanza does not gate", async () => {
    const report = withHealth(await healthyWith(), {
      bindingScope: {
        ok: false,
        partial: false,
        divergent: [],
        split: [
          {
            capability: "email",
            binding: "EMAIL_SUPPRESSIONS",
            kind: "d1",
            expected: "acme-global-email-suppressions",
            credential: null,
            repointable: true,
            package: "@pithy-sh/email",
            composing: [dirOf("api")],
            stale: [
              { worker: "api", env: "dev", name: "acme-dev-email-suppressions" },
              { worker: "api", env: "staging", name: "acme-staging-email-suppressions" },
            ],
          },
        ],
      },
    });
    const failures = failuresOf(report);
    expect(checksAndFixes(failures)).toEqual([{ check: "project", fix: null }]);
    expect(failures[0]?.detail).toContain("api binds EMAIL_SUPPRESSIONS to acme-staging-email-suppressions in staging");
  });

  test("a binding opening two databases a command can reach gates with no fix; one beside a dev id does not", async () => {
    const divergent = (ids: { id: string; at: { worker: string; env: string }[] }[]) => ({
      capability: "email",
      binding: "EMAIL_SUPPRESSIONS",
      kind: "d1" as const,
      expected: "acme-global-email-suppressions",
      credential: null,
      repointable: true,
      package: "@pithy-sh/email",
      composing: [dirOf("api")],
      ids,
    });
    const two = withHealth(await healthyWith(), {
      bindingScope: {
        ok: false,
        partial: false,
        split: [],
        divergent: [
          divergent([
            { id: "aaa", at: [{ worker: "api", env: "staging" }] },
            { id: "bbb", at: [{ worker: "web", env: "prod" }] },
          ]),
        ],
      },
    });
    const failures = failuresOf(two);
    expect(checksAndFixes(failures)).toEqual([{ check: "project", fix: null }]);
    expect(failures[0]?.detail).toContain("opens 2 different databases");

    const besideDev = withHealth(await healthyWith(), {
      ok: true,
      bindingScope: {
        ok: true,
        partial: false,
        split: [],
        divergent: [
          divergent([
            { id: "aaa", at: [{ worker: "api", env: "staging" }] },
            { id: "local", at: [{ worker: "api", env: "dev" }] },
          ]),
        ],
      },
    });
    expect(failuresOf(besideDev)).toEqual([]);
  });

  test("shared bindings read in part gate with no fix: a comparison that did not run is not one that passed", async () => {
    const report = withHealth(await healthyWith(), {
      bindingScope: { ok: false, partial: true, split: [], divergent: [] },
    });
    expect(failuresOf(report)).toEqual([
      {
        check: "project",
        detail: "part of the project's shared bindings could not be read, so the comparison is incomplete.",
        fix: null,
      },
    ]);
  });

  test("a Worker whose plan would not build could not be checked, and no command is named", async () => {
    const report = await healthyWith({
      buildPlan: async () => {
        throw new Error("planted: wrangler.jsonc would not parse");
      },
    });
    expect(failuresOf(report)).toEqual([
      {
        check: "project",
        detail: "api could not be checked: its pithy.config.ts or wrangler.jsonc would not read.",
        fix: null,
      },
    ]);
  });

  test("project health that fails on nothing a branch names still gets its entry, so the list is never short of the exit", async () => {
    const report = withHealth(await healthyWith(), {});
    expect(failuresOf(report)).toEqual([
      { check: "project", detail: "project health failed. Run pithy doctor for the lines.", fix: null },
    ]);
  });

  test("a Worker that fails on nothing a branch names still gets its entry", async () => {
    const healthy = await healthyWith();
    const [worker] = healthy.project?.health.workers ?? [];
    if (worker?.state !== "checked") throw new Error("planted: the harness Worker was not checked");
    const report = withHealth(healthy, { workers: [{ ...worker, ok: false }] });
    expect(failuresOf(report)).toEqual([
      { check: "project", detail: "api: one of its checks failed. Run pithy doctor for the lines.", fix: null },
    ]);
  });
});

describe("a Worker's declines, ledger and entitlement scan, where no command rights them", () => {
  test("a declaration that will not read, a required decline and an undeclinable one are each an edit; an unrecognized one does not gate", async () => {
    const invalid = await healthyWith({
      buildPlan: planStub(plan({ declinedBindings: { state: "invalid", problem: "Entry 0 names no binding." } })),
    });
    expect(failuresOf(invalid)).toEqual([
      {
        check: "project",
        detail: "api: declinedBindings in pithy.config.ts cannot be read. Entry 0 names no binding.",
        fix: null,
      },
    ]);

    const refused = await healthyWith({
      buildPlan: planStub(
        plan({
          declinedBindings: {
            state: "read",
            declines: [
              { state: "required", name: "DB", type: "d1", capability: "auth", reason: "No database." },
              { state: "undeclinable", name: "SENDER", type: "workflow", capability: "email", reason: "Later." },
              { state: "unrecognized", name: "OLD", reason: "Removed." },
            ],
          },
        }),
      ),
    });
    const failures = failuresOf(refused);
    expect(checksAndFixes(failures)).toEqual([
      { check: "project", fix: null },
      { check: "project", fix: null },
    ]);
    expect(failures[0]?.detail).toBe("api: DB is declined in pithy.config.ts, and auth requires it. Remove the line.");
    expect(failures[1]?.detail).toMatch(
      /^api: SENDER \(workflow\) is declined in pithy\.config\.ts, and this kind cannot be\. .* Remove the line\.$/,
    );
  });

  test("dev's ledger read in part names migrate for what it counted, and the databases it could not read, with none", async () => {
    const report = await healthyWith({
      readLedger: ledgerStubPer({
        api: {
          dev: {
            state: "partial",
            counted: { pending: 1, undeclared: [] },
            unreadable: [{ database: "app", binding: "DB" }],
          },
        },
      }),
    });
    expect(failuresOf(report).map(({ detail, fix }) => ({ detail, fix }))).toEqual([
      { detail: "api: 1 pending in dev.", fix: "pithy migrate --env dev" },
      { detail: "api: dev could not read DB (app).", fix: null },
    ]);
  });

  test("dev's ledger that would not read at all gates with no fix", async () => {
    const report = await healthyWith({ readLedger: ledgerStubPer({ api: { dev: { state: "unavailable" } } }) });
    expect(failuresOf(report)).toEqual([
      { check: "project", detail: "api: dev's migrations could not be checked.", fix: null },
    ]);
  });

  test("a source tree that would not scan for entitlement gates gates with no fix", async () => {
    const report = await healthyWith({ buildPlan: planStub(plan({ entitlements: { state: "unavailable" } })) });
    expect(failuresOf(report)).toEqual([
      {
        check: "project",
        detail: "api: its source would not scan for entitlement gates, so none was checked.",
        fix: null,
      },
    ]);
  });
});

type JsonSchemaNode = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The object schemas a node is, itself or through its union's branches. */
function objectMembers(node: unknown): JsonSchemaNode[] {
  if (!isRecord(node)) return [];
  const own = node.type === "object" || isRecord(node.properties) ? [node] : [];
  const branches = ["anyOf", "oneOf", "allOf"].flatMap((keyword) =>
    Array.isArray(node[keyword]) ? (node[keyword] as unknown[]) : [],
  );
  return [...own, ...branches.flatMap(objectMembers)];
}

/**
 * Every array of objects a JSON Schema declares, by its path in the document (`a.b[]`), and whether every
 * entry it admits declares `fix`. A union's branches share their path, and a list is fixed only when every
 * branch that reaches it says so. The fields of an entry that declares `fix` are not walked.
 */
function objectLists(node: unknown, at = "", into = new Map<string, boolean>()): Map<string, boolean> {
  if (!isRecord(node)) return into;
  const child = (key: string) => (at === "" ? key : `${at}.${key}`);
  for (const [key, property] of Object.entries(isRecord(node.properties) ? node.properties : {}))
    objectLists(property, child(key), into);
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[keyword];
    if (Array.isArray(branches)) for (const branch of branches) objectLists(branch, at, into);
  }
  if (isRecord(node.items)) {
    const members = objectMembers(node.items);
    const fixed =
      members.length > 0 &&
      members.every((member) => isRecord(member.properties) && Object.hasOwn(member.properties, "fix"));
    if (members.length > 0) into.set(`${at}[]`, (into.get(`${at}[]`) ?? true) && fixed);
    // A finding's own fields are its business: a list inside one is part of the finding, not another.
    if (!fixed) objectLists(node.items, `${at}[]`, into);
  }
  return into;
}

/**
 * A rendered payload, walked against {@link objectLists}: each list of objects the schema does not publish,
 * and each entry of a finding list without `fix`, as a sentence — with how many entries each list held. An
 * entry carrying `fix` is a finding, and its own fields are not walked; nor are the `open` blocks.
 */
function audit(
  payload: unknown,
  lists: ReadonlyMap<string, boolean>,
  open: readonly string[],
): { faults: string[]; seen: Map<string, number> } {
  const faults: string[] = [];
  const seen = new Map<string, number>();
  const walk = (value: unknown, at: string): void => {
    if (Array.isArray(value)) {
      const path = `${at}[]`;
      const entries = value.filter(isRecord);
      if (entries.length === 0) return;
      seen.set(path, (seen.get(path) ?? 0) + entries.length);
      const fixed = lists.get(path);
      if (fixed === undefined) {
        faults.push(`${path}: a list of objects the published schema does not declare`);
        return;
      }
      entries.forEach((entry, index) => {
        if (fixed && !Object.hasOwn(entry, "fix")) faults.push(`${path}: entry ${index} carries no fix`);
        if (!fixed) walk(entry, path);
      });
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, inner] of Object.entries(value)) {
      const path = at === "" ? key : `${at}.${key}`;
      if (!open.includes(path)) walk(inner, path);
    }
  };
  walk(payload, "");
  return { faults, seen };
}

/**
 * **Every finding carries `fix`, gated or not.** The exit's list is only the findings that may fail CI; the
 * rest report in their blocks and are faults all the same — a deployed environment's pending migrations, an
 * unbound secret, an AI client nobody connected. One report with a finding in every block, rendered.
 *
 * **The lists are read off the published schema, never written down here.** Every array of objects
 * `pithy schema doctor` publishes is a finding list, and declares `fix` on its entries, unless it is one of
 * {@link NOT_FINDINGS} — so a list added without `fix` fails, where a hand-kept list of the fixed ones would
 * simply not have named it. The rendered payload is then walked the same way: every list of objects in it
 * must be one the schema publishes, every entry of a finding list must carry `fix`, and every finding list
 * must be non-empty here, or this report proves nothing about it.
 */
describe("every finding in every block carries fix", () => {
  /**
   * The arrays of objects the payload publishes whose entries are not findings, each with why. A new entry
   * here is a claim a reviewer reads; a new finding list needs no entry anywhere.
   */
  const NOT_FINDINGS: Record<string, string> = {
    "project.capabilities[]": "an installed capability: its versions and the command that upgrades it",
    "project.health.workers[]": "a Worker, whose checks hold the finding lists",
    "workerNames.convention[]": "a note on wrangler's suffix that never reaches `state`",
    "extensions.extensions[]": "an extension a Worker composes",
    "settings.checked[]": "a pair the settings check ran for",
    "settings.unchecked[]": "a pair whose check could not run, which established nothing",
  };

  /**
   * The blocks published open whose lists classify names and places rather than carry findings, as
   * `docs/commands/doctor.md` says. The walk does not enter them.
   */
  const OPEN_BLOCKS = ["devSecrets", "devVarsLocal", "portsRegistry"];

  /** Every array of objects the published payload declares, by path, and whether every entry declares `fix`. */
  const lists = objectLists(doctorSchema);
  const findingLists = [...lists].filter(([, fixed]) => fixed).map(([path]) => path);

  /** A report with a finding in every block, the non-gating ones included. */
  async function everywhere(): Promise<DoctorReport> {
    const report = await healthyWith({
      buildPlan: planStub(
        plan({
          missingPrerequisites: [{ capability: "auth", requires: "email" }],
          perCapability: [
            {
              name: "media",
              missingConfigKeys: [{ key: "bucket", source: "default" } as never],
              missingEntryExports: [],
              missingBindings: [{ env: "staging", name: "MEDIA_BUCKET", type: "r2" }],
            },
          ],
          declinedBindings: {
            state: "read",
            declines: [
              { state: "required", name: "DB", type: "d1", capability: "auth", reason: "No database here." },
              { state: "unrecognized", name: "OLD_KV", reason: "Gone." },
            ],
          },
          generatedValues: {
            state: "read",
            drift: [
              {
                name: "RATE_LIMITER",
                type: "ratelimit",
                field: "namespace_id",
                expected: "1001",
                actual: "1002",
                envs: ["staging"],
                pinnedReason: null,
              },
            ],
            stalePins: [{ name: "SESSIONS", reason: "Tuned." }],
          },
        }),
      ),
      readLedger: ledgerStubPer({ api: { staging: { state: "read", pending: 3, undeclared: [] } } }),
      readCapabilityReach: async () => ({
        ok: false,
        reachable: [],
        unreachable: [{ capability: "email", package: "@pithy-sh/email", workers: [dirOf("api")] }],
        split: [
          {
            capability: "auth",
            package: "@pithy-sh/auth",
            at: [
              { worker: dirOf("api"), version: "0.9.0" },
              { worker: dirOf("web"), version: "0.8.0" },
            ],
          },
        ],
      }),
      checkProjectName: async () => ({
        state: "drifted",
        project: "acme",
        misnamed: [
          {
            name: "old-staging-db",
            project: "old",
            kind: "d1",
            worker: dirOf("api"),
            env: "staging",
            binding: "DB",
            provisioned: null,
            owner: null,
          },
        ],
      }),
      checkWorkerNames: async () => ({
        state: "drifted",
        mismatches: [{ worker: "api", stamp: "name", declared: "old-api", expected: "acme-api", envs: [] }],
        reserved: [{ worker: "api", env: "prod", name: "acme-prod-mcp", capability: "mcp" }],
        convention: [],
      }),
      checkDocsMcp: async () => ({
        state: "unconnected",
        findings: ["Cursor — pithy docs connect --client cursor"],
        clients: [{ client: "cursor", label: "Cursor" }],
      }),
      checkSelfBinding: async () => ({
        state: "unbound",
        declared: true,
        missing: [{ worker: "api", env: "staging", boundTo: null, deploysAs: "acme-staging-api" }],
      }),
      checkEnvironments: async () => ({
        state: "drifted",
        declared: ["staging", "prod"],
        drift: [{ worker: "api", env: "qa", kind: "undeclared", resources: [] }],
      }),
      checkTurnstileSitekeys: async () => ({
        state: "findings",
        unrendered: [
          { worker: dirOf("web"), environment: "staging", slot: true },
          { worker: dirOf("web"), environment: "qa", slot: false },
        ],
        stranded: [
          {
            worker: dirOf("web"),
            name: "TURNSTILE_SITEKEY_STAGING",
            environment: "staging",
            file: "/p/apps/web/wrangler.jsonc",
            removedBy: dirOf("web"),
          },
        ],
      }),
      checkSupportSearchTriggers: async () => ({
        state: "findings",
        environments: [{ env: "prod", worker: "api", directory: dirOf("api"), state: "drift", triggers: "none" }],
      }),
      checkEnvironmentInheritance: async () => ({
        state: "unrepeated",
        unrepeated: [{ worker: dirOf("api"), env: "staging", key: "vars", carries: ["APP_NAME"] }],
      }),
      checkEnvironmentConfigs: async () => ({
        unresolved: [{ environment: "prod", reason: "Set email({ baseUrl }) for prod." }],
      }),
      checkOrigins: async () => ({
        state: "drifted",
        drift: [
          {
            worker: dirOf("api"),
            env: "prod",
            fault: "unserved-origin",
            origin: "https://app.acme.dev",
            source: "declaration",
          },
        ],
      }),
      checkWorkflows: async () => ({
        state: "drifted",
        drift: [
          {
            worker: dirOf("api"),
            env: "prod",
            fault: "unsynced-stanza",
            declared: { workflows: [], crons: ["0 4 * * *"] },
            bound: { workflows: [], crons: [] },
          },
        ],
      }),
      checkSecretBindings: async () => ({
        state: "unbound",
        missing: [
          {
            worker: dirOf("api"),
            env: "staging",
            secret: "SESSION_SECRET",
            binding: "SESSION_SECRET",
            provisionable: true,
            scope: "environment",
            entry: "pithy-app-staging-session-secret",
          },
          {
            worker: dirOf("api"),
            env: "staging",
            secret: "STRIPE_KEY",
            binding: "STRIPE_KEY",
            provisionable: false,
            scope: "environment",
            entry: "pithy-app-staging-stripe-key",
          },
        ],
      }),
      checkSettings: async () => ({
        state: "faults",
        account: { state: "checked", reason: null },
        checked: [{ worker: "api", capability: "email" }],
        findings: [
          {
            worker: "api",
            capability: "email",
            tier: "local",
            environment: null,
            setting: "fromAddress",
            problem: "Missing.",
            action: "Set `email({ fromAddress })`.",
          },
        ],
        unchecked: [],
      }),
      checkDevVars: async () => ({
        root: [],
        empty: [{ worker: "api", file: "apps/api/.dev.vars" }],
        devConfigPath: null,
        mintedTokensPath: null,
        minted: [],
        devJsonSecrets: [],
        unresolvable: [],
      }),
    });
    // Doctor builds no seam for the manifest scan or the binding-scope read, so their findings are planted.
    const scope = {
      capability: "email",
      binding: "EMAIL_SUPPRESSIONS",
      kind: "d1" as const,
      expected: "acme-global-email-suppressions",
      credential: null,
      repointable: true,
      package: "@pithy-sh/email",
      composing: [dirOf("api")],
    };
    const health = report.project?.health;
    if (health === undefined) throw new Error("planted: the harness report has no project");
    return withHealth(report, {
      ...health,
      manifests: { ok: false, faults: [{ package: "@pithy-sh/audit", reason: "Unexpected token." }] },
      bindingScope: {
        ok: false,
        partial: false,
        split: [{ ...scope, stale: [{ worker: "api", env: "staging", name: "acme-staging-email-suppressions" }] }],
        divergent: [
          {
            ...scope,
            ids: [
              { id: "aaa", at: [{ worker: "api", env: "staging" }] },
              { id: "bbb", at: [{ worker: "web", env: "prod" }] },
            ],
          },
        ],
      },
    });
  }

  test("every list of objects the schema publishes is a finding list with fix, or is named as not one", () => {
    expect(findingLists.length).toBeGreaterThan(20);
    expect(
      [...lists]
        .filter(([, fixed]) => !fixed)
        .map(([path]) => path)
        .sort(),
    ).toEqual(Object.keys(NOT_FINDINGS).sort());
  });

  test("each finding list has its findings here, and every one of them carries fix", async () => {
    const { faults, seen } = audit(renderDoctorJson(await everywhere()), lists, OPEN_BLOCKS);
    expect(faults).toEqual([]);
    expect(findingLists.filter((path) => (seen.get(path) ?? 0) === 0)).toEqual([]);
  });

  /** The value at a dotted path. */
  const at = (payload: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | null)?.[key], payload);

  /** Every `fix` value anywhere in the payload, the exit's own list included. */
  function everyFix(value: unknown): unknown[] {
    if (Array.isArray(value)) return value.flatMap(everyFix);
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, inner]) => (key === "fix" ? [inner] : everyFix(inner)));
  }

  test("the payload conforms to the schema that requires it, and every fix in it runs as written", async () => {
    const report = await everywhere();
    const payload = renderDoctorJson(report);
    await expectConforms("doctor", () => formatJsonLine(payload));
    const fixes = everyFix(payload);
    expect(fixes.length).toBeGreaterThan(findingLists.length);
    expect(fixes.every((fix) => fix === null || typeof fix === "string")).toBe(true);
    const commands = fixes.filter((fix): fix is string => typeof fix === "string");
    expect(commands.map(unrunnable).filter((why) => why !== null)).toEqual([]);
  });

  test("the findings that never gate name their commands", async () => {
    const payload = renderDoctorJson(await everywhere());
    const fixesAt = (path: string) => (at(payload, path) as { fix: string | null }[]).map((entry) => entry.fix);
    expect(fixesAt("secretBindings.missing")).toEqual([
      // A value the kit composes is minted by a provision of every environment, production included: no fix (#711).
      null,
      "pithy secrets create STRIPE_KEY --env staging",
    ]);
    expect(fixesAt("docsMcp.clients")).toEqual(["pithy docs connect --client cursor"]);
    expect(fixesAt("devVars.empty")).toEqual(["pithy seed --env dev"]);
    expect(fixesAt("turnstileSitekeys.unrendered")).toEqual(["pithy turnstile provision --worker web", null]);
    expect(fixesAt("turnstileSitekeys.stranded")).toEqual(["pithy turnstile provision --worker web"]);
    expect(fixesAt("settings.findings")).toEqual([null]);
    const migrations = at(payload, "project.health.workers.0.migrations.environments") as {
      env: string;
      fix: unknown;
    }[];
    expect(migrations.find((entry) => entry.env === "staging")?.fix).toBe("pithy migrate --env staging");
  });

  // Where a finding both gates and reports, its block and the exit's entry read the same builder.
  test("a finding that also gates carries the same fix in its block as in the exit's list", async () => {
    const report = await everywhere();
    const payload = renderDoctorJson(report);
    const failed = new Set(doctorFailures(report).map((failure) => failure.fix));
    for (const path of [
      "selfBinding.missing",
      "origins.drift",
      "workflows.drift",
      "supportSearchTriggers.environments",
    ]) {
      for (const { fix } of at(payload, path) as { fix: string | null }[]) expect(failed.has(fix), path).toBe(true);
    }
  });
});

/** Planted defects: the runnable check above has to see a fix it could not run, or it proves nothing. */
describe("the runnable check", () => {
  test("refuses prose, a command nobody has, and a flag the command does not declare", () => {
    expect(unrunnable("pithy worker sync --worker api --env prod")).toBeNull();
    expect(unrunnable("Run pithy worker sync.")).not.toBeNull();
    expect(unrunnable("pithy worker resync --worker api")).not.toBeNull();
    expect(unrunnable("pithy email provision --env prod")).not.toBeNull();
  });
});

/** Planted defects: the derivation and the walk above have to see what they exist to catch, or they prove nothing. */
describe("the finding-list audit", () => {
  const Planted = z
    .object({
      block: z
        .object({
          fixed: z
            .array(
              z
                .looseObject({
                  fix: z.string().nullable().describe("F."),
                  parts: z.array(z.object({ a: z.string().describe("A.") }).describe("A part.")).describe("Parts."),
                })
                .describe("A finding."),
            )
            .describe("Fixed."),
          bare: z.array(z.looseObject({}).describe("A finding.")).describe("Bare."),
          names: z.array(z.string().describe("A name.")).describe("Names."),
        })
        .nullable()
        .describe("A block."),
    })
    .describe("Planted.");
  const lists = objectLists(z.toJSONSchema(Planted, { io: "input" }));

  test("a list of objects declared without fix is read as one, beside the one declared with it", () => {
    expect([...lists]).toEqual([
      ["block.fixed[]", true],
      ["block.bare[]", false],
    ]);
  });

  test("an entry without fix, and a list the schema does not declare, are each named", () => {
    const payload = {
      block: { fixed: [{ fix: null }, { detail: "no fix" }], bare: [{ a: 1 }], names: ["x"] },
      stray: [{ detail: "undeclared" }],
      skipped: [{ detail: "open" }],
    };
    const { faults, seen } = audit(payload, lists, ["skipped"]);
    expect(faults).toEqual([
      "block.fixed[]: entry 1 carries no fix",
      "stray[]: a list of objects the published schema does not declare",
    ]);
    expect(seen.get("block.fixed[]")).toBe(2);
  });
});
