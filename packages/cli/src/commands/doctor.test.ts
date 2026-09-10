// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ConflictError, InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildReconcilePlan } from "../capabilities/reconcile";
import type { PortsRegistryCheck, PortsRegistryEntry } from "../doctor/portsRegistry";
import type { ProjectLedger } from "../migrations/run";
import type { FetchLike } from "../notifier/check";
import { readState, writeState } from "../notifier/state";
import { scaffoldProject } from "../project/scaffold";
import type { ResolvedWorker } from "../project/workerScope";
import {
  checkedWorker,
  cleanPlanFor,
  doctorHarness,
  planStub,
  planStubPer,
  registryFetch,
  workerSet,
} from "../test-utils/doctorHarness";
import { linkKitPackages } from "../test-utils/linkKit";
import doctor, {
  buildDoctorReport,
  type DoctorReport,
  type DoctorReportOptions,
  detectRuntime,
  doctorExitCode,
  installedCapabilityVersions,
  renderDoctorJson,
  renderDoctorText,
  versionState,
} from "./doctor";

const harness = doctorHarness();
const { baseOptions, healthyOptions } = harness;
const cleanPlan = cleanPlanFor("api");

// The harness makes a fresh directory per test; these mirror it for the tests that address it directly.
let dir: string;
let stateFile: string;
beforeEach(() => {
  dir = harness.dir;
  stateFile = harness.stateFile;
});

describe("installedCapabilityVersions", () => {
  test("empty when there is no node_modules/@pithy-sh", async () => {
    expect(await installedCapabilityVersions(dir)).toEqual([]);
  });

  test("reads versions and excludes the CLI package itself", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const packages: [string, string][] = [
      ["core", "1.2.0"],
      ["auth", "1.1.8"],
      ["cli", "1.3.0"],
    ];
    for (const [name, version] of packages) {
      const pkg = join(dir, "node_modules", "@pithy-sh", name);
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: `@pithy-sh/${name}`, version }));
    }
    expect(await installedCapabilityVersions(dir)).toEqual([
      { name: "@pithy-sh/auth", version: "1.1.8" },
      { name: "@pithy-sh/core", version: "1.2.0" },
    ]);
  });
});

describe("buildDoctorReport — cache bypass and state", () => {
  test("always queries the registry even when the cache is fresh", async () => {
    // Pre-seed a fresh state; doctor must still fetch.
    await writeState(stateFile, { lastCheck: 1_000, latestVersion: "1.2.0", installer: "bun", notifier: true });
    const fetch = registryFetch({ cli: "1.3.0" });
    await buildDoctorReport(baseOptions({ fetch }));
    expect(fetch).toHaveBeenCalledWith("https://registry.npmjs.org/@pithy-sh%2Fcli/latest", expect.anything());
  });

  test("persists the fresh check into the state file", async () => {
    await buildDoctorReport(baseOptions({ now: () => 9_999 }));
    const state = await readState(stateFile);
    expect(state.lastCheck).toBe(9_999);
    expect(state.latestVersion).toBe("1.3.0");
    expect(state.installer).toBe("bun");
  });
});

describe("buildDoctorReport — project detection", () => {
  test("outside a project → project is null", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        loadProject: async () => {
          throw new NotFoundError({ message: "No pithy.config.ts here." });
        },
      }),
    );
    expect(report.project).toBeNull();
  });

  test("a present-but-unloadable config degrades to a toolchain report and fails the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        loadProject: async () => {
          throw new InternalError({ message: "Could not load pithy.config.ts.", action: "Run bun install." });
        },
      }),
    );
    expect(report.project).toBeNull();
    expect(report.projectLoadError).toBe("Could not load pithy.config.ts. Run bun install.");
    expect(doctorExitCode(report)).toBe(1);
    expect(renderDoctorText(report, "/home/u")).toContain("could not load — Could not load pithy.config.ts.");
  });

  test("a project with no workers is a broken project, not 'outside a project'", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        resolveWorkers: async () => {
          throw new NotFoundError({ message: "No workers here.", action: "Run pithy worker add <name>." });
        },
      }),
    );
    expect(report.projectLoadError).toBe("No workers here. Run pithy worker add <name>.");
    expect(doctorExitCode(report)).toBe(1);
  });

  test("inside a project → capabilities carry installed vs latest", async () => {
    const report = await buildDoctorReport(
      baseOptions({ fetch: registryFetch({ cli: "1.3.0", core: "1.2.0", auth: "1.2.0", leaderboard: "1.2.0" }) }),
    );
    expect(report.project?.capabilities).toEqual([
      { name: "@pithy-sh/core", installed: "1.2.0", latest: "1.2.0", state: "current" },
      { name: "@pithy-sh/auth", installed: "1.1.8", latest: "1.2.0", state: "outdated" },
      { name: "@pithy-sh/leaderboard", installed: "1.2.0", latest: "1.2.0", state: "current" },
    ]);
  });
});

describe("renderDoctorText", () => {
  test("outdated layout matches docs/CLI.md §5.6 exactly", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.2.0",
        fetch: registryFetch({ cli: "1.3.0", core: "1.2.0", auth: "1.2.0", leaderboard: "1.2.0" }),
        buildPlan: planStub({
          worker: "api",
          deployedAs: "acme-api",
          env: "dev",
          ejectedSkipped: [],
          perCapability: [
            {
              name: "media",
              missingConfigKeys: [],
              missingEntryExports: [],
              missingBindings: [
                { env: "staging", name: "MEDIA_BUCKET", type: "r2" },
                { env: "prod", name: "MEDIA_BUCKET", type: "r2" },
              ],
            },
          ],
          ledger: { state: "read", pending: 2, undeclared: [] },
          entitlements: { state: "read", gates: [] },
          missingPrerequisites: [],
          declinedBindings: { state: "read", declines: [] },
          generatedValues: { state: "read", drift: [], stalePins: [] },
          missingVersionMetadata: false,
        }),
      }),
    );
    expect(renderDoctorText(report, "/home/u")).toBe(
      [
        "",
        "pithy 1.2.0 (installed via bun)",
        "Update available: 1.3.0",
        "Run: bun update -g @pithy-sh/cli",
        "",
        "Shell: zsh (~/.zshrc)",
        "Alias: installed (`p.` → `pithy`)",
        "",
        "Config dir: ~/.config/pithy",
        `State file: ${report.stateFile}`,
        "Ports:      ~/.config/pithy/dev-ports.json",
        "            8787–8806  main",
        "Notifier:   enabled (PITHY_NO_UPDATE_NOTIFIER to disable)",
        "",
        "Project: pithy.config.ts found",
        "Project capabilities:",
        "  @pithy-sh/core         1.2.0 ✓",
        "  @pithy-sh/auth         1.1.8 (1.2.0 available — run `pithy upgrade`)",
        "  @pithy-sh/leaderboard  1.2.0 ✓",
        "",
        "Project health:",
        "  api:",
        "    prereqs      every composed capability has its peers ✓",
        "    config       parses against every capability schema ✓",
        "    bindings     MEDIA_BUCKET (r2) missing from wrangler.jsonc",
        "                 env: staging, prod",
        "    migrations   2 pending — run: pithy migrate --env dev",
        "    entitlements no gated route without a provider ✓",
        "",
        "Cloudflare: token active; checked: API tokens — no other product was reached",
        "",
        "Project name: pithy-app — every resource name matches",
        "",
        "OS:      macOS 14.5",
        "Runtime: Node 22.10.0",
      ].join("\n"),
    );
  });

  test("health groups per worker; a healthy one collapses to a line, an unhealthy one lists its checks", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0", core: "1.2.0", auth: "1.2.0", leaderboard: "1.2.0" }),
        installedCapabilities: async () => [{ name: "@pithy-sh/core", version: "1.2.0" }],
        resolveWorkers: async () => workerSet("api", "collab"),
        buildPlan: planStubPer({
          api: cleanPlanFor("api"),
          collab: { ...cleanPlanFor("collab"), ledger: { state: "read", pending: 2, undeclared: [] } },
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain(
      [
        "Project health:",
        "  api: healthy ✓",
        "  collab:",
        "    prereqs      every composed capability has its peers ✓",
        "    config       parses against every capability schema ✓",
        "    bindings     all required bindings present ✓",
        "    migrations   2 pending — run: pithy migrate --env dev",
        "    entitlements no gated route without a provider ✓",
      ].join("\n"),
    );
  });

  /**
   * **#533's follow-on: the command an adopter runs when something is wrong finally says this.**
   *
   * The Worker composes `payments` and its five checks are green — a composition that loaded is a
   * composition that loaded. Nothing else in the report notices that the package behind it is installed
   * nowhere: it ships no manifest to any scan, so no binding of its is checked and no config option of
   * its is read, and the first thing to say so is whichever `pithy payments …` command refuses next.
   *
   * `pithy add payments` is the remedy **here**, and it is the sentence #533 was reported about being
   * printed somewhere else: at a package the project already had, where it installs nothing and rewrites
   * a hand-built `pithy.config.ts` for the privilege. Resolution reaches a per-Worker install now, so a
   * capability that reaches this list is composed and installed nowhere, which is what `pithy add` is for.
   */
  test("a capability that is composed and installed nowhere is named, with the command that fixes it", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0" }),
        installedCapabilities: async () => [],
        resolveWorkers: async () => workerSet("api"),
        buildPlan: planStub(cleanPlanFor("api")),
      }),
    );
    if (!report.project) throw new Error("the fixture must load a project — the health block has nowhere to sit.");
    report.project.health = {
      ...report.project.health,
      ok: false,
      capabilityReach: {
        ok: false,
        reachable: ["auth"],
        unreachable: [{ capability: "payments", package: "@pithy-sh/payments", workers: ["api"] }],
      },
    };
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain(
      [
        "Project health:",
        "  capabilities:",
        "    payments is composed, and @pithy-sh/payments is not installed",
        "      composed by api",
        "      Nothing resolves it — not the project root, not any Worker's own node_modules — so",
        "      every command that reaches into it refuses, and every check below skips it.",
        "      Run: pithy add payments",
      ].join("\n"),
    );
  });

  /**
   * A capability nothing can reach is a fault this project's own files establish, so it gates CI.
   *
   * **Through the seam, never by editing the finished report.** The first draft of this test set
   * `health.ok = false` in the same object literal as the finding, and `doctorExitCode` reads exactly that
   * field — so the red exit was earned by the literal and the finding it names was decoration. It passed
   * with the whole chain from `capabilityReach.ok` to the exit code disconnected. `readCapabilityReach` is
   * forwarded for this: the finding goes in where the real check would produce it, `buildProjectHealth`
   * conjoins it into `health.ok` itself, and the exit follows from the finding or the test fails.
   */
  test("a capability the CLI cannot resolve fails the exit", async () => {
    const options = {
      installedVersion: "1.3.0",
      fetch: registryFetch({ cli: "1.3.0" }),
      installedCapabilities: async () => [],
      resolveWorkers: async () => workerSet("api"),
      buildPlan: planStub(cleanPlanFor("api")),
    } as const;

    const healthy = await buildDoctorReport(baseOptions({ ...options }));
    expect(doctorExitCode(healthy)).toBe(0);
    expect(healthy.project?.health.ok).toBe(true);

    const report = await buildDoctorReport(
      baseOptions({
        ...options,
        readCapabilityReach: async () => ({
          ok: false,
          reachable: [],
          unreachable: [{ capability: "payments", package: "@pithy-sh/payments", workers: ["api"] }],
        }),
      }),
    );
    if (!report.project) throw new Error("the fixture must load a project — the health block has nowhere to sit.");
    // Nothing here writes `ok`. It is the conjunction `buildProjectHealth` computed, and the only block
    // that changed is the reach one.
    expect(report.project.health.capabilityReach.ok).toBe(false);
    expect(report.project.health.ok).toBe(false);
    expect(doctorExitCode(report)).toBe(1);
    // And it rides in `--json` with the rest of the project's health, so an agent reads the same fact.
    const json = renderDoctorJson(report) as { project: { health: { capabilityReach: { ok: boolean } } } };
    expect(json.project.health.capabilityReach.ok).toBe(false);
  });

  /**
   * **The block reports an install and never a location, because a location is no longer a fault.**
   *
   * Round two printed `installed under apps/api/node_modules` — the Worker directories that had the
   * package the root chain did not — because that layout was the defect. It is a supported install now
   * (`project/kitResolve.ts`), so the only capability that reaches this list is one no directory has, and
   * a report still naming a directory would be naming one that does not exist.
   */
  test("the block never claims the package is installed somewhere", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0" }),
        installedCapabilities: async () => [],
        resolveWorkers: async () => workerSet("api"),
        buildPlan: planStub(cleanPlanFor("api")),
        readCapabilityReach: async () => ({
          ok: false,
          reachable: [],
          unreachable: [{ capability: "payments", package: "@pithy-sh/payments", workers: ["api"] }],
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("payments is composed, and @pithy-sh/payments is not installed");
    expect(text).toContain("composed by api");
    expect(text).not.toContain("installed under");
  });

  /**
   * #513, and the case that would otherwise be invisible: a stale `env dev` name **never fails the exit**,
   * because `pithy provision` writes `env.<stanza>` and never reaches the top-level one, and locally the
   * binding is the address anyway. So the block cannot be gated on `ok` alone — it would print this
   * finding on every report except the ones it is for, which is the collapse #440 and #499 each removed
   * one level up.
   */
  test("a project-global binding a project still binds per environment opens the health block on its own", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0" }),
        installedCapabilities: async () => [],
        resolveWorkers: async () => workerSet("api"),
        buildPlan: planStub(cleanPlanFor("api")),
      }),
    );
    if (!report.project) throw new Error("the fixture must load a project — the health block has nowhere to sit.");
    report.project.health = {
      ...report.project.health,
      // Every Worker passes and the whole project is `ok`. Only the `dev` stanza disagrees, and no
      // command rewrites it.
      ok: true,
      bindingScope: {
        ok: true,
        partial: false,
        divergent: [],
        split: [
          {
            capability: "email",
            package: "@pithy-sh/email",
            binding: "EMAIL_SUPPRESSIONS",
            kind: "d1",
            expected: "acme-global-email-suppressions",
            credential: null,
            stale: [{ worker: "api", env: "dev", name: "acme-dev-email-suppressions" }],
            repointable: true,
          },
        ],
      },
    };
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain(
      [
        "Project health:",
        "  shared:",
        "    EMAIL_SUPPRESSIONS (d1) is one resource for the whole project: acme-global-email-suppressions",
        "      api env.dev points at acme-dev-email-suppressions",
        "      No command rewrites env dev, and locally the binding is the address — edit it or leave it.",
      ].join("\n"),
    );
    // No `Run:` line, because there is no environment `provision` would reach.
    expect(text).not.toContain("pithy provision --env dev");
  });

  /**
   * **The order the section prints its remedy in, because the reverse of it loses data (#513 review).**
   *
   * `pithy provision` changes which resource a binding names and moves nothing. The per-environment
   * resource is the one that has been in use — `EMAIL_SUPPRESSIONS` and `SUPPORT_BUCKET` are both bound
   * in the **app** Worker's env — so the project-global one is the empty side, and repointing first makes
   * every existing suppression stop being honored and every stored attachment unreachable. The section
   * used to say only "check them for rows before deleting", which is the wrong end of it twice: the loss
   * is at the repoint, and nothing is deleted at all.
   */
  test("the shared section says copy first, and says it before the command that repoints", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0" }),
        installedCapabilities: async () => [],
        resolveWorkers: async () => workerSet("api"),
        buildPlan: planStub(cleanPlanFor("api")),
      }),
    );
    if (!report.project) throw new Error("the fixture must load a project — the health block has nowhere to sit.");
    report.project.health = {
      ...report.project.health,
      ok: false,
      bindingScope: {
        ok: false,
        partial: false,
        divergent: [],
        split: [
          {
            capability: "email",
            package: "@pithy-sh/email",
            binding: "EMAIL_SUPPRESSIONS",
            kind: "d1",
            expected: "acme-global-email-suppressions",
            credential: null,
            stale: [{ worker: "api", env: "staging", name: "acme-staging-email-suppressions" }],
            repointable: true,
          },
        ],
      },
    };
    const text = renderDoctorText(report, "/home/u");

    expect(text).toContain("Copy the rows across first.");
    expect(text).toContain("every unsubscribe recorded above stops being honored, and nothing moves it for you.");
    // The order is the instruction. A `Run:` line above the copy would be the sentence read first.
    expect(text.indexOf("Copy the rows across first.")).toBeLessThan(
      text.indexOf("Then run: pithy provision --env staging"),
    );
    // And the sentence that was the wrong end of it is gone rather than merely joined.
    expect(text).not.toContain("Check them for rows before deleting.");

    // **The destination may not exist, and doctor cannot know.** It reads files and never reaches the
    // account, so `pithy email provision` may never have run — and where it has not, the only runnable
    // line left on screen is the repoint, which creates the project-global database itself and leaves the
    // operator live on something created empty seconds earlier. The command that makes it comes first.
    expect(text).toContain("Make the destination if it is not there yet: pithy email provision");
    expect(text.indexOf("pithy email provision")).toBeLessThan(text.indexOf("Then run: pithy provision"));

    // **The pair that used to be printed here is gone, and nothing replaced it with another one.**
    // `wrangler d1 export <db>` with no flag reports `Resource location: local`, exports
    // `.wrangler/state`, and exits 0 — so the operator ran the repoint underneath believing production
    // had been copied. With `--remote` it still cannot work: the dump carries `pithy_migrations` and
    // explicit row ids, and the execute aborts transactionally having written nothing.
    expect(text).not.toContain("wrangler d1 export each old database");
    expect(text).toContain("The copy is not an export and an import.");
    // **And the pointer is a URL, because the published package has no `docs/` in it (#513 review, round
    // three).** `packages/cli/package.json` `files` ships `dist`, `src`, `scripts` and `templates`, so
    // `docs/commands/doctor.md §…` named a file no adopter who installed the CLI has — the same defect as
    // a command that does not run, one indirection along. `doctorDocs.test.ts` holds the URL to the page
    // it renders at and to a heading that page has; here it is only required to be a URL and not a path.
    expect(text).toContain(
      "The sequence that works: https://pithy.sh/docs/cli/commands/doctor#carrying-the-data-across",
    );
    expect(text).not.toContain("docs/commands/doctor.md");

    // The invariant behind that, stated so it holds against whatever gets added here later: this section
    // never prints a `wrangler d1` line without `--remote`, because the default is the local database.
    expect(text.split("\n").filter((line) => /\bwrangler d1\b/.test(line) && !line.includes("--remote"))).toEqual([]);

    // **And which row wins — stated as what the sequence does, never as homework (#513 review, round
    // three).** `email` is unique, so two environments make two rows of one address. The sentence used to
    // tell the operator to "keep the stricter", above a sequence whose `INSERT OR IGNORE` kept whichever
    // row arrived first: on this page's own worked example the weaker row won on both criteria. The
    // sequence carries an `ON CONFLICT(email) DO UPDATE … WHERE` clause now, so the rule is applied
    // rather than remembered, and the line says which rule that is.
    expect(text).toContain("One address suppressed in two of them is two rows that merge into one.");
    // **Led by the clause that actually fires.** Reading the precedence top to bottom put
    // permanent-beats-temporary first, which is the test two observed rows never fail: every suppression
    // the kit writes is permanent, so the decision reaches `created_at` every time. A sentence that leads
    // on a branch real data cannot take is accurate about the SQL and wrong as advice.
    expect(text).toContain("The sequence keeps the");
    expect(text).toContain("earlier row, unless one of them expires and the other does not");
    expect(text).toContain("Everything the kit writes is permanent, so it is usually the date.");
    expect(text).not.toContain("That call is yours.");
  });

  test("an r2 binding gets the objects sentence, not the rows one", async () => {
    // A bucket cannot be exported with `wrangler d1`, and the thing that becomes unreachable is an
    // attachment rather than an unsubscribe. One sentence for two kinds would be true of neither.
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0" }),
        installedCapabilities: async () => [],
        resolveWorkers: async () => workerSet("api"),
        buildPlan: planStub(cleanPlanFor("api")),
      }),
    );
    if (!report.project) throw new Error("the fixture must load a project — the health block has nowhere to sit.");
    report.project.health = {
      ...report.project.health,
      ok: false,
      bindingScope: {
        ok: false,
        partial: false,
        divergent: [],
        split: [
          {
            capability: "support",
            package: "@pithy-sh/support",
            binding: "SUPPORT_BUCKET",
            kind: "r2",
            expected: "acme-global-support",
            credential: "support-r2-credentials",
            stale: [{ worker: "api", env: "staging", name: "acme-staging-support-bucket" }],
            repointable: true,
          },
        ],
      },
    };
    const text = renderDoctorText(report, "/home/u");

    expect(text).toContain("Copy the objects across first.");
    // **The repoint moves the writes, and only the writes (#513 review, round three).** For support the
    // binding is write-only — `attachment/store.ts` and `inbound/ingest.ts` both `put`, nothing under
    // `packages/support/src` ever calls `get` or `head`, and the one read is `store.presignGet` signed
    // against `credentials.bucket`. So "every attachment in the old ones becomes unreachable" was false
    // on the repoint alone, and the same screen said so three lines below in the credential sentence.
    expect(text).toContain("The repoint changes which bucket the binding names, not what");
    expect(text).not.toContain("every attachment and raw message in the old ones becomes unreachable");
    expect(text).toContain("Sync each old bucket into acme-global-support over R2's S3 endpoint");
    expect(text).toContain("The old buckets are left where they are.");
    expect(text).not.toContain("wrangler d1 export");
    expect(text).toContain("Make the destination if it is not there yet: pithy support provision");

    // **The binding is not the only place the bucket is named (#513 review).** Attachments are written
    // through `env.SUPPORT_BUCKET`, and every presigned URL is signed against the `bucket` field inside
    // `support-r2-credentials` — a second string the repoint does not touch, and one nothing in the kit
    // writes. Move one without the other and writes go to the project-global bucket while signed reads
    // keep addressing the per-environment one, so everything stored after the repoint 404s.
    expect(text).toContain("support-r2-credentials names the bucket every presigned URL is signed against");
    // Both directions of the split, because each costs something different and the operator picks an order.
    expect(text).toContain("leave the secret and everything stored after the repoint");
    expect(text).toContain("update it and everything you did not copy is unreachable.");
    expect(text).toContain("pithy secrets update support-r2-credentials --env staging");
    // Beside the repoint, in the runnable half, and after it: the credential is updated to match a
    // binding that has already moved.
    expect(text.indexOf("Then run: pithy provision --env staging")).toBeLessThan(
      text.indexOf("pithy secrets update support-r2-credentials --env staging"),
    );
    // `set` is not a subcommand of `pithy secrets`, and a remedy naming one would be #517 again.
    expect(text).not.toContain("pithy secrets set");

    // **And `update` is not the command on every project (#513 review, round three).** `pithy secrets
    // update` refuses a secret that does not exist, and nothing in the kit ever writes this one — `pithy
    // support provision` writes none — so a project whose attachments were written but never signed-read
    // has none, and the printed line would exit 1 on exactly the project that has this finding. The
    // alternative is named once, after the runs: it is the same act with the same arguments, and which
    // verb applies is a fact about the project rather than about the environment.
    expect(text).toContain("A project that has never signed a read has no support-r2-credentials to update.");
    expect(text).toContain("command is pithy secrets create, with the same arguments.");
    expect(text.split("\n").filter((line) => line.includes("pithy secrets create"))).toHaveLength(1);
  });

  /**
   * **The skew this check exists for, and the remedy it must not print there (#513 review, #517).**
   *
   * The finding is keyed on the capability's own namer so a newer CLI beside an older `@pithy-sh/email`
   * still answers — that install is the one most likely to be split. But `pithy provision` composes the
   * name from that older manifest, so the run writes the per-environment name straight back and the next
   * `doctor` prints the same finding. Naming a command that cannot clear its own finding is #517's
   * defect, which took four rounds; here the package moves first and the report says so.
   */
  test("under version skew the report names the package to upgrade before the run", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0" }),
        installedCapabilities: async () => [],
        resolveWorkers: async () => workerSet("api"),
        buildPlan: planStub(cleanPlanFor("api")),
      }),
    );
    if (!report.project) throw new Error("the fixture must load a project — the health block has nowhere to sit.");
    report.project.health = {
      ...report.project.health,
      ok: false,
      bindingScope: {
        ok: false,
        partial: false,
        divergent: [],
        split: [
          {
            capability: "email",
            package: "@pithy-sh/email",
            binding: "EMAIL_SUPPRESSIONS",
            kind: "d1",
            expected: "acme-global-email-suppressions",
            credential: null,
            stale: [{ worker: "api", env: "staging", name: "acme-staging-email-suppressions" }],
            repointable: false,
          },
        ],
      },
    };
    const text = renderDoctorText(report, "/home/u");

    expect(text).toContain("Nothing installed declares this binding project-wide, so pithy provision would compose");
    expect(text).toContain("Upgrade @pithy-sh/email first");
    // Still the command, and still after the step that makes it work.
    expect(text.indexOf("Upgrade @pithy-sh/email first")).toBeLessThan(
      text.indexOf("Then run: pithy provision --env staging"),
    );
  });

  /**
   * **The divergence half carries the same carry-over, because it is the same loss (#513 review).**
   *
   * Two stanzas naming one resource and opening two is `hostEnv.ts`'s "bound identically in every
   * environment" failing on the id rather than on the name. Repointing them at one strands whatever the
   * other holds, exactly as the name split does — so the section says which to copy before it says which
   * command to run, and the ids above it are what the decision is made from.
   */
  test("two stanzas opening two resources get the copy-first step and the run after it", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0" }),
        installedCapabilities: async () => [],
        resolveWorkers: async () => workerSet("api"),
        buildPlan: planStub(cleanPlanFor("api")),
      }),
    );
    if (!report.project) throw new Error("the fixture must load a project — the health block has nowhere to sit.");
    report.project.health = {
      ...report.project.health,
      ok: false,
      bindingScope: {
        ok: false,
        partial: false,
        split: [],
        divergent: [
          {
            capability: "email",
            package: "@pithy-sh/email",
            binding: "EMAIL_SUPPRESSIONS",
            kind: "d1",
            expected: "acme-global-email-suppressions",
            credential: null,
            ids: [
              { id: "sup-1", at: [{ worker: "api", env: "staging" }] },
              { id: "sup-2", at: [{ worker: "api", env: "prod" }] },
            ],
            repointable: true,
          },
        ],
      },
    };
    const text = renderDoctorText(report, "/home/u");

    expect(text).toContain("EMAIL_SUPPRESSIONS is bound to 2 different resources");
    expect(text).toContain("sup-1: api env.staging");
    expect(text).toContain("It must be bound identically in every environment.");

    // **Its own remedy, not the split branch's (#513 review).** Both stanzas here already carry the
    // expected *name*, so "export each old database, then execute it against acme-global-email-
    // suppressions" named one string as both source and destination — a database exporting into itself,
    // and `wrangler d1 export` addresses a database by name or binding and never by id anyway.
    expect(text).toContain("Two databases are open and one survives.");
    expect(text).toContain("Decide from the ids which one that is, and copy the other's rows into it first.");
    expect(text).not.toContain("Copy the rows across first.");
    expect(text).not.toContain("The old databases are left where they are.");

    // **The environments are enumerated, because the entry has them.** `ids[].at[].env` is the same data
    // the split branch enumerates from, and this branch was degrading it to a placeholder nobody can
    // paste — on the screen where the decision is actually made.
    expect(text).toContain("Then run: pithy provision --env staging");
    expect(text).toContain("Then run: pithy provision --env prod");
    expect(text).not.toContain("pithy provision --env <env>");

    // The decision is named, and so is the fact that the command does not make it.
    expect(text).toContain("pithy provision picks it by name, not from the ids");
    expect(text.indexOf("Two databases are open and one survives.")).toBeLessThan(
      text.indexOf("Then run: pithy provision --env staging"),
    );
  });

  /**
   * **A divergence cannot be addressed by the name the two databases share (#513 review, round three).**
   *
   * Every command in the sequence the split branch points at is `wrangler d1 <verb> <resource-name>`, and
   * that is right there: the stanzas name *different* databases and each name resolves. A pure divergence
   * is the opposite state — two databases answering to one name — and against wrangler 4.130.0 the shared
   * name resolves to neither, a uuid in its place is refused the same way, and `-e <env>` plus the binding
   * is the only form that reaches one. So the branch says so, names the binding, and points at the
   * subsection that carries that sequence rather than at the one written for names that resolve.
   */
  test("the divergent branch names the addressing that reaches a shared name, and its own section", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0" }),
        installedCapabilities: async () => [],
        resolveWorkers: async () => workerSet("api"),
        buildPlan: planStub(cleanPlanFor("api")),
      }),
    );
    if (!report.project) throw new Error("the fixture must load a project — the health block has nowhere to sit.");
    report.project.health = {
      ...report.project.health,
      ok: false,
      bindingScope: {
        ok: false,
        partial: false,
        split: [],
        divergent: [
          {
            capability: "email",
            package: "@pithy-sh/email",
            binding: "EMAIL_SUPPRESSIONS",
            kind: "d1",
            expected: "acme-global-email-suppressions",
            credential: null,
            ids: [
              { id: "sup-1", at: [{ worker: "api", env: "staging" }] },
              { id: "sup-2", at: [{ worker: "api", env: "prod" }] },
            ],
            repointable: true,
          },
        ],
      },
    };
    const text = renderDoctorText(report, "/home/u");

    expect(text).toContain("They answer to one name, so no wrangler command can tell them apart by it.");
    expect(text).toContain("only through its own stanza — the EMAIL_SUPPRESSIONS binding under -e <env>");
    // Its own anchor, never the split branch's: that section's commands all address a database by name.
    expect(text).toContain(
      "The sequence that works: https://pithy.sh/docs/cli/commands/doctor#when-two-databases-answer-to-one-name",
    );
    expect(text).not.toContain("doctor#carrying-the-data-across");
    // And the addressing sentence comes before the link, so the reason is read before the destination.
    expect(text.indexOf("They answer to one name")).toBeLessThan(text.indexOf("The sequence that works:"));
  });

  /**
   * **A divergence only `dev` is part of is reported, explained, and green (#513 review, round three).**
   *
   * `pithy provision` writes `config.env[<stanza>]`, so nothing rewrites the top-level one — which the
   * split branch has said since #513 and the divergent branch did not. There a `dev` id beside one
   * managed id failed the exit unconditionally: every printed line ran, `doctor` still exited 1, and the
   * same screen said nothing would ever rewrite the dev id. There is also no choice to make between two
   * live databases here, so the remedy that describes one is not printed at all.
   */
  test("a divergence the dev stanza alone is part of prints the dev line and no choice to make", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0" }),
        installedCapabilities: async () => [],
        resolveWorkers: async () => workerSet("api"),
        buildPlan: planStub(cleanPlanFor("api")),
      }),
    );
    if (!report.project) throw new Error("the fixture must load a project — the health block has nowhere to sit.");
    report.project.health = {
      ...report.project.health,
      ok: true,
      bindingScope: {
        ok: true,
        partial: false,
        split: [],
        divergent: [
          {
            capability: "email",
            package: "@pithy-sh/email",
            binding: "EMAIL_SUPPRESSIONS",
            kind: "d1",
            expected: "acme-global-email-suppressions",
            credential: null,
            ids: [
              { id: "sup-local", at: [{ worker: "api", env: "dev" }] },
              { id: "sup-1", at: [{ worker: "api", env: "prod" }] },
            ],
            repointable: true,
          },
        ],
      },
    };
    const text = renderDoctorText(report, "/home/u");

    expect(text).toContain("EMAIL_SUPPRESSIONS is bound to 2 different resources");
    expect(text).toContain("sup-local: api env.dev");
    expect(text).toContain(
      "No command rewrites env dev, and locally the binding is the address — edit it or leave it.",
    );
    // No remedy, because there is nothing to choose between and nothing for a run to change.
    expect(text).not.toContain("Two databases are open and one survives.");
    expect(text).not.toContain("Then run: pithy provision --env prod");
  });

  /**
   * **The split branch's wording must not reappear on the divergent one, and the reverse (#513 review).**
   *
   * The two shapes shared one remedy for a round, which is how a sentence written for a stale *name*
   * came to be printed under two live *ids* — where it named the same string as both ends of the copy.
   * They are separate functions now, so this is the assertion that keeps them separate: each branch's
   * opening sentence appears under its own finding and under no other.
   */
  test("neither branch prints the other's copy sentence", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0" }),
        installedCapabilities: async () => [],
        resolveWorkers: async () => workerSet("api"),
        buildPlan: planStub(cleanPlanFor("api")),
      }),
    );
    if (!report.project) throw new Error("the fixture must load a project — the health block has nowhere to sit.");
    report.project.health = {
      ...report.project.health,
      ok: false,
      bindingScope: {
        ok: false,
        partial: false,
        split: [
          {
            capability: "email",
            package: "@pithy-sh/email",
            binding: "EMAIL_SUPPRESSIONS",
            kind: "d1",
            expected: "acme-global-email-suppressions",
            credential: null,
            stale: [{ worker: "api", env: "staging", name: "acme-staging-email-suppressions" }],
            repointable: true,
          },
        ],
        divergent: [
          {
            capability: "support",
            package: "@pithy-sh/support",
            binding: "SUPPORT_BUCKET",
            kind: "r2",
            expected: "acme-global-support",
            credential: "support-r2-credentials",
            repointable: true,
            ids: [
              { id: "b-1", at: [{ worker: "api", env: "staging" }] },
              { id: "b-2", at: [{ worker: "api", env: "prod" }] },
            ],
          },
        ],
      },
    };
    const text = renderDoctorText(report, "/home/u");

    // One of each, and each says its own thing. The r2 divergence is unreachable from a real
    // `wrangler.jsonc` — a bucket's name is its address, so nothing fills an id for one — but the kind is
    // carried rather than assumed, and a remedy that talked about rows there would be a lie by default.
    expect(text).toContain("Copy the rows across first.");
    expect(text).toContain("Two buckets are open and one survives.");
    expect(text).not.toContain("Two databases are open");
    expect(text).not.toContain("Copy the objects across first.");
    // The credential belongs to the bucket, not to the database, in both branches.
    expect(text).toContain("pithy secrets update support-r2-credentials --env prod");
    expect(text.split("\n").filter((line) => line.includes("pithy secrets update"))).toHaveLength(2);
  });

  /**
   * #282. Nothing was pending, so the line read `none pending ✓` — about a database `pithy migrate`
   * refused to touch. The two directions are two different faults with two different remedies, so the
   * undeclared one gets its own sentence rather than a second number on the pending line.
   */
  test("a migration the ledger records and the project no longer declares gets its own line and remedy", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0", core: "1.2.0" }),
        installedCapabilities: async () => [{ name: "@pithy-sh/core", version: "1.2.0" }],
        buildPlan: planStub({
          ...cleanPlan,
          ledger: {
            state: "read",
            pending: 0,
            undeclared: [{ database: "app", binding: "DB", name: "0250_audit_0002_tenant" }],
          },
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain(
      [
        "    migrations   DB records 0250_audit_0002_tenant. This project no longer declares it.",
        "                 Nothing migrates until the ledger and the declaration agree. This is the local dev store, so wiping it is cheap: delete .wrangler/state, then run pithy migrate --env dev again.",
      ].join("\n"),
    );
    expect(doctorExitCode(report)).toBe(1);
  });

  test("an entitlement gap names the gating files and the command that fixes it", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        fetch: registryFetch({ cli: "1.3.0", core: "1.2.0" }),
        installedCapabilities: async () => [{ name: "@pithy-sh/core", version: "1.2.0" }],
        buildPlan: planStub({
          ...cleanPlan,
          entitlements: { state: "read", gates: ["src/routes/reports.ts", "src/routes/team.ts"] },
        }),
      }),
    );
    expect(renderDoctorText(report, "/home/u")).toContain(
      [
        "    entitlements gated routes, no provider — run: pithy add payments",
        "                 src/routes/reports.ts",
        "                 src/routes/team.ts",
      ].join("\n"),
    );
  });

  test("up-to-date layout is terser and omits the config/health blocks", async () => {
    const report = await buildDoctorReport(healthyOptions());
    expect(renderDoctorText(report, "/home/u")).toBe(
      [
        "",
        "pithy 1.3.0 (installed via brew)",
        "Up to date.",
        "",
        "Shell: zsh",
        "Alias: installed",
        "",
        "Project: pithy.config.ts found",
        "Project capabilities: all up to date",
        "",
        "Cloudflare: token active; checked: API tokens — no other product was reached",
        "",
        "OS:      macOS 14.5",
        "Runtime: Node 22.10.0",
      ].join("\n"),
    );
  });

  /**
   * Outside a project the `Project:` block states the one fact — there is no config here — and every other
   * project line is gone, including `Project name:`. Two lines answering the same question is how the
   * previous doctor defects happened: the name line used to advise adding a key to a file that did not
   * exist, while the block whose job that is printed nothing at all.
   */
  test("no pithy.config.ts here — the Project line says so, and no other line answers a project question", async () => {
    const probe = vi.fn(async () => ({ state: "ok" as const, project: "pithy-app", misnamed: [] }));
    const report = await buildDoctorReport(
      baseOptions({
        installedVersion: "1.3.0",
        argv1: "/opt/homebrew/bin/pithy",
        fetch: registryFetch({ cli: "1.3.0" }),
        // The real loader, against a temp directory with no config — the case the defect was reported from.
        loadProject: undefined,
        checkProjectName: probe,
      }),
    );
    // The name question is never asked, so nothing can answer it wrongly.
    expect(report.projectName).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    // Terse: someone running doctor outside a project is asking about their toolchain, and it is fine.
    expect(renderDoctorText(report, "/home/u")).toBe(
      [
        "",
        "pithy 1.3.0 (installed via brew)",
        "Up to date.",
        "",
        "Shell: zsh",
        "Alias: installed",
        "",
        "Project: no pithy.config.ts here — run `pithy init`, or change to a project directory",
        "",
        "Cloudflare: token active; checked: API tokens — no other product was reached",
        "",
        "OS:      macOS 14.5",
        "Runtime: Node 22.10.0",
      ].join("\n"),
    );
    // Checking the CLI version, the shell, or the alias from anywhere is legitimate and never a fault.
    expect(doctorExitCode(report)).toBe(0);
  });

  test("a project that loaded but names nothing still says where to set the name", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkProjectName: async () => ({ state: "unconfigured", project: null, misnamed: [] }) }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Project: pithy.config.ts found");
    // The advice is correct here and only here: the file exists, and it is missing a key.
    expect(text).toContain(
      "Project name: not set (add `name` to pithy.config.ts — every resource name derives from it)",
    );
    expect(doctorExitCode(report)).toBe(0);
  });
});

/**
 * The #371 gates on this report's eleven probes. A report is what an adopter reads to find out why
 * something is wrong, so one probe that throws must cost its own line and leave the other ten standing.
 *
 * Planted one probe at a time, in both halves of the defect the issue names: an **unguarded** probe, whose
 * throw used to take the whole report, and a **guarded** one, whose throw used to be filed under `null` —
 * indistinguishable from the question not arising here.
 */
describe("a probe that throws", () => {
  const throwing = (message: string) => () => {
    throw new Error(message);
  };

  test("an unguarded probe that throws costs its own line, never the other ten", async () => {
    const control = await buildDoctorReport(harness.healthyOptions());
    const report = await buildDoctorReport(
      harness.healthyOptions({
        // Was unguarded: this threw straight out of buildDoctorReport.
        checkProjectName: throwing("EACCES: permission denied, open '/home/dev/acme/pithy.config.ts'"),
      }),
    );

    // Its own value says it could not be checked — not "ok", and not the `null` that means no project.
    expect(report.projectName).toEqual({ state: "could-not-check", project: null, misnamed: [] });
    expect(control.projectName?.state).toBe("ok");
    // And **nothing else moved**, asserted against the same report without the plant rather than against a
    // handful of fields somebody remembered to list.
    expect({ ...report, projectName: null }).toEqual({ ...control, projectName: null });
    // It establishes nothing, so it does not gate CI.
    expect(doctorExitCode(report)).toBe(0);
    // And nothing the throw said travels — this payload is read by scripts and printed to a terminal.
    expect(JSON.stringify(renderDoctorJson(report))).not.toMatch(/EACCES|permission denied/);
  });

  test("a guarded probe that throws is distinguishable from one that had nothing to say", async () => {
    const thrown = await buildDoctorReport(
      harness.healthyOptions({
        // Was guarded — into `null`, which already meant "this project composes no secrets".
        checkDevSecrets: throwing("EACCES: permission denied, open '/home/dev/.config/pithy/acme/secrets.jsonc'"),
      }),
    );
    const quiet = await buildDoctorReport(harness.healthyOptions({ checkDevSecrets: async () => null }));

    expect(thrown.devSecrets).toEqual({ state: "could-not-check" });
    expect(quiet.devSecrets).toBeNull();
    // The two are different facts and no longer the same bytes.
    expect(thrown.devSecrets).not.toEqual(quiet.devSecrets);
    // And the failed one carries no findings to read as an all-clear.
    expect(thrown.devSecrets && "misplaced" in thrown.devSecrets).toBe(false);
    // The report says so out loud rather than printing the same silence a clean file produces.
    expect(renderDoctorText(thrown, "/home/u")).toContain("secrets.jsonc: couldn't be checked.");
    expect(renderDoctorText(quiet, "/home/u")).not.toContain("couldn't be checked");
    // Every sibling probe still reported — asserted against the quiet report, which differs from this one
    // in exactly the probe that was planted.
    expect({ ...thrown, devSecrets: null }).toEqual({ ...quiet, devSecrets: null });
    // And nothing from the throw travels.
    expect(JSON.stringify(renderDoctorJson(thrown))).not.toMatch(/EACCES|permission denied/);
  });
});

describe("doctorExitCode", () => {
  test("0 when all health checks pass", async () => {
    const report = await buildDoctorReport(baseOptions());
    expect(doctorExitCode(report)).toBe(0);
  });

  test("non-zero when the config health check fails", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        buildPlan: planStub({
          ...cleanPlan,
          perCapability: [
            {
              name: "auth",
              missingBindings: [],
              missingConfigKeys: [{ key: "basePath", default: "/auth", describe: "x" }],
              missingEntryExports: [],
            },
          ],
        }),
      }),
    );
    expect(checkedWorker(report.project?.health).config.ok).toBe(false);
    expect(doctorExitCode(report)).toBe(1);
  });

  test("non-zero when any one worker is unhealthy, even with the rest healthy", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        resolveWorkers: async () => workerSet("api", "collab", "web"),
        buildPlan: planStubPer({
          collab: { ...cleanPlanFor("collab"), ledger: { state: "read", pending: 1, undeclared: [] } },
        }),
      }),
    );
    expect(report.project?.health.workers.map((worker) => worker.state === "checked" && worker.ok)).toEqual([
      true,
      false,
      true,
    ]);
    expect(report.project?.health.ok).toBe(false);
    expect(doctorExitCode(report)).toBe(1);
  });

  test("zero when every worker is healthy", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        resolveWorkers: async () => workerSet("api", "collab"),
        buildPlan: planStubPer({}),
      }),
    );
    expect(report.project?.health.workers).toHaveLength(2);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("non-zero when the bindings health check fails", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        buildPlan: planStub({
          ...cleanPlan,
          perCapability: [
            {
              name: "media",
              missingConfigKeys: [],
              missingEntryExports: [],
              missingBindings: [{ env: "staging", name: "MEDIA_BUCKET", type: "r2" }],
            },
          ],
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
  });

  test("non-zero when a Durable Object class is missing from the entry, and the block names it", async () => {
    // The half of the binding `wrangler.jsonc` cannot show. Reported under `bindings` because that is
    // what it is: one binding written in two files, and the deploy needs both.
    const report = await buildDoctorReport(
      baseOptions({
        buildPlan: planStub({
          ...cleanPlan,
          perCapability: [
            {
              name: "multiplayer",
              missingConfigKeys: [],
              missingBindings: [],
              missingEntryExports: ["MultiplayerSession"],
            },
          ],
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
    expect(renderDoctorText(report, "/home/u")).toContain("MultiplayerSession not exported from this worker's entry");
  });

  test("non-zero when migrations are pending", async () => {
    const report = await buildDoctorReport(
      baseOptions({ buildPlan: planStub({ ...cleanPlan, ledger: { state: "read", pending: 3, undeclared: [] } }) }),
    );
    expect(checkedWorker(report.project?.health).migrations).toEqual({
      ok: false,
      ledger: { state: "read", pending: 3, undeclared: [] },
      env: "dev",
    });
    expect(doctorExitCode(report)).toBe(1);
  });

  /**
   * #264. A declared origin with nothing serving it is the one this command's own remedy produced: it
   * told an adopter to close `workers.dev` beside a domain whose route had never been written, then
   * reported the result — a Worker reachable at no address — as healthy, exit 0.
   */
  test("non-zero when a declared origin has nothing serving it, and the block names the route", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkOrigins: async () => ({
          state: "drifted",
          drift: [
            {
              worker: "board",
              env: "prod",
              fault: "unserved-origin",
              origin: "https://app.example.com",
              source: "declaration",
            },
          ],
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("no route in env.prod serves it");
    expect(text).toContain("pithy worker sync");
    // The remedy that caused the fault must not be the remedy printed for it.
    expect(text).not.toContain('Set "workers_dev": false in env.prod');
  });

  /** Still the day-one state of every project, and still not a red exit. */
  test("zero when the only origin fault is an environment with no origin at all", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkOrigins: async () => ({
          state: "drifted",
          drift: [{ worker: "board", env: "staging", fault: "no-origin", origin: null }],
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });

  /**
   * #267. The only fault in this report whose whole symptom is that nothing happens: a job declared,
   * `pithy worker sync` never run, and the cron that would have fired it never written. The block has to
   * name both sides of the comparison — what is declared and what is bound — because the reader is being
   * told about a table in a file they believed already matched.
   */
  test("non-zero when a stanza does not bind what the app declares, and the block names both sides", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkWorkflows: async () => ({
          state: "drifted",
          drift: [
            {
              worker: "board",
              env: "prod",
              fault: "unsynced-stanza",
              declared: {
                workflows: [{ binding: "DIGEST", name: "replay-prod-board-digest", class_name: "DigestWorkflow" }],
                crons: ["0 4 * * *"],
              },
              bound: { workflows: [], crons: [] },
            },
          ],
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("DIGEST → replay-prod-board-digest");
    expect(text).toContain("cron 0 4 * * *");
    expect(text).toContain("env.prod binds nothing");
    expect(text).toContain("pithy worker sync");
  });

  /**
   * #271. A Better Auth plugin an adopter composed adds routes to the Worker and tables to the
   * database, and has no `package.json` for `Project capabilities:` to name it from. It is not a fault
   * — so it prints without one, and it never gates.
   */
  test("a composed extension is named, with the tables it brought, and never fails the exit", async () => {
    // The fixture composes `auth`, so it has to *have* `auth` — the same thing an adopter's project has
    // to have, and what `capabilities:` reports when it does not (#533's follow-on). Before the check
    // landed, a composition nothing could resolve was invisible and this fixture was quietly one.
    await linkKitPackages(dir, ["auth"]);
    const report = await buildDoctorReport(
      baseOptions({
        resolveWorkers: async () =>
          [
            {
              name: "board",
              dir: "/p/apps/board",
              capabilities: [
                {
                  name: "auth",
                  requiredBindings: [],
                  extensions: [{ kind: "better-auth-plugin", id: "organization", tables: ["organization", "member"] }],
                } as unknown as Capability,
              ],
            },
          ] as unknown as ResolvedWorker[],
        buildPlan: planStub(cleanPlanFor("board")),
      }),
    );

    expect(doctorExitCode(report)).toBe(0);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Capability extensions:");
    expect(text).toContain("auth: organization (better-auth-plugin), tables organization, member.");
    expect(renderDoctorJson(report)).toMatchObject({
      extensions: { extensions: [expect.objectContaining({ id: "organization", worker: "board" })] },
    });
  });

  test("a project that composes no extension prints no block about it", async () => {
    const report = await buildDoctorReport(baseOptions());
    expect(report.extensions).toEqual({ extensions: [] });
    expect(renderDoctorText(report, "/home/u")).not.toContain("Capability extensions:");
  });

  /** Nothing was established, so nothing gates — the same standard every other check here is held to. */
  test("zero when the workflow declaration could not be checked at all", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkWorkflows: async () => ({ state: "could-not-check", drift: [] }) }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });

  test("outside a project, health never fails the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        loadProject: async () => {
          throw new NotFoundError({ message: "No pithy.config.ts here." });
        },
      }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });
});

describe("renderDoctorJson", () => {
  test("mirrors every block", async () => {
    const report: DoctorReport = await buildDoctorReport(
      baseOptions({ fetch: registryFetch({ cli: "1.3.0", core: "1.2.0", auth: "1.2.0", leaderboard: "1.2.0" }) }),
    );
    const json = renderDoctorJson(report);
    expect(json.cli).toMatchObject({ installed: "1.2.0", latest: "1.3.0", installer: "bun", state: "outdated" });
    expect(json.shell).toBe("zsh");
    expect(json.alias).toEqual({ state: "installed", rcPath: "/home/u/.zshrc", reason: null });
    expect(json.notifier).toBe("enabled");
    expect(json.os).toBe("macOS 14.5");
    expect(json.node).toBe("22.10.0");
    expect((json.project as { present: boolean }).present).toBe(true);
  });

  test("outside a project both project keys are null — the same fact, stated once", async () => {
    const report = await buildDoctorReport(baseOptions({ loadProject: undefined }));
    const json = renderDoctorJson(report);
    expect(json.project).toBeNull();
    expect(json.projectName).toBeNull();
  });

  test("a project that names nothing keeps the unconfigured state and its detail line", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkProjectName: async () => ({ state: "unconfigured", project: null, misnamed: [] }) }),
    );
    const json = renderDoctorJson(report) as { projectName: { state: string; project: null; detail: string } };
    expect(json.projectName.state).toBe("unconfigured");
    expect(json.projectName.project).toBeNull();
    expect(json.projectName.detail).toContain("add `name` to pithy.config.ts");
  });
});

describe("notifier opt-out reflected in the report", () => {
  test("state notifier:false shows disabled and survives the doctor state write", async () => {
    await writeState(stateFile, { lastCheck: 0, latestVersion: null, installer: "bun", notifier: false });
    const report = await buildDoctorReport(baseOptions());
    expect(report.notifierEnabled).toBe(false);
    expect(report.notifierDisabledBy).toBe("state");
    // A doctor run refreshes the version fields but must not clobber the opt-out flag (persists across runs).
    expect((await readState(stateFile)).notifier).toBe(false);
    await buildDoctorReport(baseOptions());
    expect((await readState(stateFile)).notifier).toBe(false);
  });

  test("PITHY_NO_UPDATE_NOTIFIER shows disabled via env", async () => {
    const report = await buildDoctorReport(baseOptions({ env: { PITHY_NO_UPDATE_NOTIFIER: "1" } }));
    expect(report.notifierEnabled).toBe(false);
    expect(report.notifierDisabledBy).toBe("env");
  });
});

describe("--worker", () => {
  test("the command declares the flag docs/CLI.md §1.1 gives every fan-out command", () => {
    const args = doctor.args as Record<string, { type: string }>;
    expect(args.worker).toMatchObject({ type: "string" });
  });

  test("threads the name to the resolver, and passes none when the flag is absent", async () => {
    const seen: { projectDir: string; worker?: string }[] = [];
    const resolveWorkers = async (options: { projectDir: string; worker?: string }) => {
      seen.push(options);
      return workerSet("api");
    };

    await buildDoctorReport(baseOptions({ resolveWorkers }));
    await buildDoctorReport(baseOptions({ worker: "api", resolveWorkers }));
    expect(seen).toEqual([{ projectDir: dir }, { projectDir: dir, worker: "api" }]);
  });

  test("narrows the exit gate — an unrelated unhealthy worker no longer fails the run", async () => {
    const all = workerSet("api", "collab");
    const resolveWorkers = async ({ worker }: { projectDir: string; worker?: string }) =>
      worker === undefined ? all : all.filter((candidate) => candidate.name === worker);
    const buildPlan = planStubPer({
      collab: { ...cleanPlanFor("collab"), ledger: { state: "read", pending: 2, undeclared: [] } },
    });

    const whole = await buildDoctorReport(baseOptions({ resolveWorkers, buildPlan }));
    expect(whole.project?.health.workers.map((worker) => worker.worker)).toEqual(["api", "collab"]);
    expect(doctorExitCode(whole)).toBe(1);

    const narrowed = await buildDoctorReport(baseOptions({ worker: "api", resolveWorkers, buildPlan }));
    expect(narrowed.project?.health.workers.map((worker) => worker.worker)).toEqual(["api"]);
    expect(doctorExitCode(narrowed)).toBe(0);
  });
});

/**
 * The health block end to end — the real reconcile engine against real `apps/<name>/` files, with only the
 * migration count stubbed. Capabilities install **once** at the project root and are wired per Worker, so a
 * package installed for one Worker must never show up as another's drift.
 */
describe("project health — installed is not composed (regression)", () => {
  let projectDir: string;
  let api: string;
  let web: string;

  const composes = (...names: string[]): Capability[] => names.map((name) => ({ name, requiredBindings: [] }));

  /** A Worker as the resolver seam returns it; `ResolvedWorker` is satisfied structurally. */
  const worker = (name: string, workerDir: string, capabilities: Capability[]) =>
    ({ name, dir: workerDir, capabilities }) as unknown as ResolvedWorker;

  /** Doctor with the real reconcile engine — the plan builder is not stubbed. */
  function realEngine(workers: ResolvedWorker[]): DoctorReportOptions {
    return baseOptions({
      projectDir,
      resolveWorkers: async () => workers,
      buildPlan: undefined,
      readLedger: async (): Promise<ProjectLedger> => ({ state: "read", pending: 0, undeclared: [] }),
    });
  }

  beforeEach(async () => {
    projectDir = join(dir, "project");
    await scaffoldProject({ targetDir: projectDir, appName: "doctor-test" });
    api = join(projectDir, "apps", "api");
    web = join(projectDir, "apps", "web");
    await cp(api, web, { recursive: true });
    // A copied Worker is a second Worker, so it carries the first one's script name and `WORKER` var —
    // which is precisely the drift `checkWorkerNames` now fails the exit on. Stamped for the directory it
    // was copied into, the way `pithy worker add` would have written it.
    const copied = join(web, "wrangler.jsonc");
    await writeFile(
      copied,
      (await readFile(copied, "utf8")).replaceAll("doctor-test-api", "doctor-test-web").replaceAll('"api"', '"web"'),
    );
    // `pithy add auth --worker api`: one install at the project root, wired into api alone.
    const pkgDir = join(projectDir, "node_modules", "@pithy-sh", "auth");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "pithy.manifest.json"),
      JSON.stringify({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [
          { type: "d1", name: "DB" },
          { type: "kv", name: "SESSIONS" },
        ],
      }),
    );
  });

  test("a worker composing nothing is healthy and exits zero", async () => {
    const report = await buildDoctorReport(realEngine([worker("web", web, [])]));
    expect(checkedWorker(report.project?.health).bindings).toEqual({
      ok: true,
      missing: [],
      missingExports: [],
      declinedBindings: { state: "read", declines: [] },
      generatedValues: { state: "read", drift: [], stalePins: [] },
    });
    expect(report.project?.health.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("the worker that does compose it still reports its drift", async () => {
    const report = await buildDoctorReport(realEngine([worker("api", api, composes("auth"))]));
    expect(checkedWorker(report.project?.health).bindings.missing.map((binding) => binding.name)).toEqual([
      "DB",
      "SESSIONS",
    ]);
    expect(doctorExitCode(report)).toBe(1);
  });

  test("across both workers, only the composing one is unhealthy", async () => {
    const report = await buildDoctorReport(realEngine([worker("api", api, composes("auth")), worker("web", web, [])]));
    expect(
      report.project?.health.workers.map((entry) => [entry.worker, entry.state === "checked" && entry.ok]),
    ).toEqual([
      ["api", false],
      ["web", true],
    ]);
  });
});

describe("shared engine", () => {
  test("the doctor command re-exports the same buildReconcilePlan upgrade uses", async () => {
    const { defaultBuildPlan } = await import("../doctor/health");
    expect(defaultBuildPlan).toBe(buildReconcilePlan);
  });
});

describe("cloudflare credentials", () => {
  test("a reachable account reports its token status and does not fail the exit", async () => {
    const report = await buildDoctorReport(baseOptions());
    expect(report.cloudflare).toEqual({ state: "ok", missing: [], tokenStatus: "active", credentialSplit: null });
    expect(doctorExitCode(report)).toBe(0);
  });

  test("unconfigured credentials never fail the exit — an unprovisioned project is legitimate", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkCloudflare: async () => ({
          state: "unconfigured",
          missing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
          tokenStatus: null,
          credentialSplit: null,
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });

  test("a rejected token fails the exit, so CI gates on it", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkCloudflare: async () => ({
          state: "token_invalid",
          missing: [],
          tokenStatus: null,
          credentialSplit: null,
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
  });

  test("a live token pointed at the wrong account fails the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkCloudflare: async () => ({
          state: "account_unreachable",
          missing: [],
          tokenStatus: "active",
          credentialSplit: null,
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
  });

  test("the text report names only the missing key, not both", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkCloudflare: async () => ({
          state: "unconfigured",
          missing: ["CLOUDFLARE_API_TOKEN"],
          tokenStatus: null,
          credentialSplit: null,
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain(
      "Cloudflare: not configured (set CLOUDFLARE_API_TOKEN in ~/.config/pithy/cloudflare.json, or the environment)",
    );
    expect(text).not.toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  test("a split credential group is reported even though the credentials are reachable", async () => {
    const split = { fromFile: ["CLOUDFLARE_API_TOKEN"], fromEnvironment: ["CLOUDFLARE_ACCOUNT_ID"] };
    const report = await buildDoctorReport(
      healthyOptions({
        checkCloudflare: async () => ({ state: "ok", missing: [], tokenStatus: "active", credentialSplit: split }),
      }),
    );
    // The whole report stays terse — the split earns its one line, and nothing else is dragged out with
    // it. `Project name:` is the neighboring verbose-only block, and it is still absent.
    expect(renderDoctorText(report, "/home/u")).toBe(
      [
        "",
        "pithy 1.3.0 (installed via brew)",
        "Up to date.",
        "",
        "Shell: zsh",
        "Alias: installed",
        "",
        "Project: pithy.config.ts found",
        "Project capabilities: all up to date",
        "",
        "Cloudflare: token active; checked: API tokens — no other product was reached; credentials come from two places — cloudflare.json sets CLOUDFLARE_API_TOKEN, the environment supplies CLOUDFLARE_ACCOUNT_ID — set the whole pair in one of them",
        "",
        "OS:      macOS 14.5",
        "Runtime: Node 22.10.0",
      ].join("\n"),
    );
    // A warning, not a gate — the pair may well work, and only an established fault fails the exit.
    expect(doctorExitCode(report)).toBe(0);

    const json = renderDoctorJson(report) as { cloudflare: { credentialSplit: unknown } };
    expect(json.cloudflare.credentialSplit).toEqual(split);
  });

  test("a clean setup still prints the line, because it names the account, not a complaint", async () => {
    // The terse report exists to say nothing when nothing is wrong. This line is not a finding — it is a
    // location, and the run most likely to be about to deploy is the one where everything else is green
    // (#206). Same rule the `Secrets:` line follows.
    const report = await buildDoctorReport(healthyOptions());
    expect(renderDoctorText(report, "/home/u")).toContain("Cloudflare:");
  });

  test("the resolved file is tilde-abbreviated, exactly as every other path in the report is", async () => {
    const report = await buildDoctorReport(
      healthyOptions({
        checkCloudflare: async () => ({
          state: "ok" as const,
          missing: [],
          tokenStatus: "active",
          credentialSplit: null,
          configPath: "/home/u/.config/pithy/cloudflare.leed.json",
          accountName: "leed",
          accountMismatch: null,
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("~/.config/pithy/cloudflare.leed.json");
    expect(text).not.toContain("/home/u/.config/pithy/cloudflare.leed.json");
  });

  test("--json carries the resolved file, the account name, and any mismatch", async () => {
    const report = await buildDoctorReport(
      healthyOptions({
        checkCloudflare: async () => ({
          state: "ok" as const,
          missing: [],
          tokenStatus: "active",
          credentialSplit: null,
          configPath: "/home/u/.config/pithy/cloudflare.leed.json",
          accountName: "leed",
          accountMismatch: null,
        }),
      }),
    );
    // Absolute here, not abbreviated: an agent reading this needs a path it can open.
    expect(renderDoctorJson(report).cloudflare).toMatchObject({
      configPath: "/home/u/.config/pithy/cloudflare.leed.json",
      accountName: "leed",
      accountMismatch: null,
    });
  });

  test("--json reports null for each of those when nothing named a file", async () => {
    const report = await buildDoctorReport(healthyOptions());
    expect(renderDoctorJson(report).cloudflare).toMatchObject({
      configPath: null,
      accountName: null,
      accountMismatch: null,
    });
  });

  test("--json carries the state and a human detail line", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkCloudflare: async () => ({
          state: "token_invalid",
          missing: [],
          tokenStatus: null,
          credentialSplit: null,
        }),
      }),
    );
    const json = renderDoctorJson(report) as { cloudflare: { state: string; detail: string } };
    expect(json.cloudflare.state).toBe("token_invalid");
    expect(json.cloudflare.detail).toContain("CLOUDFLARE_API_TOKEN rejected");
  });
});

/**
 * `PITHY_OFFLINE` (#218). `doctor` is the command people run when something is wrong, including on a
 * machine that is not theirs — so it is the one that must be able to answer without reaching anything.
 */
describe("offline", () => {
  /** A registry stub that fails the test rather than answering: nothing may query npm in this mode. */
  function forbiddenFetch(): FetchLike {
    return (async () => {
      throw new Error("nothing may reach the network when the caller has said offline");
    }) as unknown as FetchLike;
  }

  test("the variable puts the whole report offline, with no flag and no seam", async () => {
    const report = await buildDoctorReport(
      healthyOptions({ env: { PITHY_OFFLINE: "1" }, fetch: forbiddenFetch(), checkCloudflare: undefined }),
    );
    expect(report.offline).toBe(true);
    expect(report.cloudflare.state).toBe("not_checked");
    expect(doctorExitCode(report)).toBe(0);
  });

  test("the option forces it with no variable set, which is what --offline passes", async () => {
    const report = await buildDoctorReport(
      healthyOptions({ offline: true, fetch: forbiddenFetch(), checkCloudflare: undefined }),
    );
    expect(report.offline).toBe(true);
    expect(report.cloudflare.state).toBe("not_checked");
  });

  test("the registry is not queried either — a diagnostic that claims offline may not phone npm", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("unreachable");
    }) as unknown as FetchLike;
    const report = await buildDoctorReport(healthyOptions({ offline: true, fetch, checkCloudflare: undefined }));
    expect(fetch).not.toHaveBeenCalled();
    expect(report.cli.latest).toBeNull();
    expect(report.cli.state).toBe("unknown");
  });

  test("the version lines say skipped, not unreachable — the registry was never asked", async () => {
    const report = await buildDoctorReport(
      healthyOptions({ offline: true, fetch: forbiddenFetch(), checkCloudflare: undefined }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Version check skipped (offline).");
    expect(text).toContain("Project capabilities: version check skipped (offline)");
    expect(text).not.toContain("registry unreachable");
  });

  test("the Cloudflare line says what was not done, and never reads as a pass", async () => {
    const report = await buildDoctorReport(
      healthyOptions({ offline: true, fetch: forbiddenFetch(), checkCloudflare: undefined }),
    );
    expect(renderDoctorText(report, "/home/u")).toContain(
      "Cloudflare: not checked — offline (PITHY_OFFLINE or --offline)",
    );
  });

  test("--json carries the mode, so an agent can tell a skipped check from a passing one", async () => {
    const report = await buildDoctorReport(
      healthyOptions({ offline: true, fetch: forbiddenFetch(), checkCloudflare: undefined }),
    );
    const json = renderDoctorJson(report) as { offline: boolean; cloudflare: { state: string } };
    expect(json.offline).toBe(true);
    expect(json.cloudflare.state).toBe("not_checked");
  });

  test("an ordinary run is untouched — `offline` is false and every check still runs", async () => {
    const report = await buildDoctorReport(healthyOptions());
    expect(report.offline).toBe(false);
    expect(renderDoctorJson(report).offline).toBe(false);
    expect(report.cli.latest).toBe("1.3.0");
    expect(renderDoctorText(report, "/home/u")).not.toContain("PITHY_OFFLINE");
  });

  test("a not-checked Cloudflare state never fails the exit — nothing was established", () => {
    const report = { cloudflare: { state: "not_checked" }, project: null } as unknown as DoctorReport;
    expect(doctorExitCode(report)).toBe(0);
  });

  test("--json names where the credentials came from, on every run", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkCloudflare: async () => ({
          state: "ok",
          missing: [],
          tokenStatus: "active",
          credentialSplit: null,
          configPath: "/home/u/.config/pithy/cloudflare.json",
          accountName: null,
          accountMismatch: null,
          credentialSource: "environment",
        }),
      }),
    );
    expect(renderDoctorJson(report).cloudflare).toMatchObject({ credentialSource: "environment" });
    expect(renderDoctorText(report, "/home/u")).toContain(
      "credentials from the environment, not ~/.config/pithy/cloudflare.json",
    );
  });
});

describe("project name", () => {
  /** A misnamed resource, as the probe reports one. `owner` is the only field that proves anything. */
  const misnamed = (name: string, provisioned: boolean | null, owner: string | null = null) => ({
    name,
    project: "oldname",
    kind: "d1" as const,
    worker: "api",
    env: "prod",
    binding: "DB",
    provisioned,
    owner,
  });

  /** The two names a wholesale rename leaves — drift is plural by construction. */
  const renamed = [misnamed("oldname-prod-db", null), misnamed("oldname-dev-db", null)];

  test("a matching name does not fail the exit and stays out of the terse report", async () => {
    const report = await buildDoctorReport(baseOptions({ installedVersion: "1.3.0" }));
    expect(report.projectName?.state).toBe("ok");
    expect(doctorExitCode(report)).toBe(0);
  });

  test("no name yet never fails the exit — an unconfigured project is legitimate", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkProjectName: async () => ({ state: "unconfigured", project: null, misnamed: [] }) }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });

  test("could-not-check never fails the exit — nothing was established either way", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkProjectName: async () => ({ state: "could-not-check", project: "pithy-app", misnamed: [] }),
      }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });

  test("a name that is set but illegal fails the exit — every other command already refuses it", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkProjectName: async () => ({ state: "invalid", project: "2026-launch", misnamed: [] }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Project name: ");
    expect(text).toContain("2026-launch");
    expect(text).not.toContain("not set");
  });

  test("--json carries the invalid state and the name that was actually set", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkProjectName: async () => ({ state: "invalid", project: "2026-launch", misnamed: [] }),
      }),
    );
    const json = renderDoctorJson(report) as { projectName: { state: string; project: string; detail: string } };
    expect(json.projectName.state).toBe("invalid");
    expect(json.projectName.project).toBe("2026-launch");
    expect(json.projectName.detail).toContain("2026-launch");
  });

  test("a wholesale rename fails the exit, so CI gates on it", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkProjectName: async () => ({ state: "drifted", project: "pithy-app", misnamed: renamed }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain('Project name: 2 resource names this project declares lead with "oldname"');
    // Drift has established no ownership, so it never reaches for the word.
    expect(text).not.toContain("orphan");
  });

  test("orphaned resources fail the exit and the text names the stamp that proved it", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkProjectName: async () => ({
          state: "orphaned",
          project: "pithy-app",
          misnamed: [misnamed("oldname-prod-db", true, "oldname")],
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(1);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain('Project name: 1 resource is stamped "oldname" by pithy migrate');
    expect(text).toContain("pithy-app will never find it again");
    // Never, on any path, does doctor tell an adopter to delete a live resource.
    expect(text).not.toContain("delete");
  });

  test("--json carries the state, the misnamed resources, and a human detail line", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkProjectName: async () => ({
          state: "orphaned",
          project: "pithy-app",
          misnamed: [misnamed("oldname-prod-db", true, "oldname")],
        }),
      }),
    );
    const json = renderDoctorJson(report) as {
      projectName: {
        state: string;
        project: string;
        misnamed: { name: string; provisioned: boolean | null; owner: string | null }[];
        detail: string;
      };
    };
    expect(json.projectName.state).toBe("orphaned");
    expect(json.projectName.project).toBe("pithy-app");
    expect(json.projectName.misnamed[0]?.name).toBe("oldname-prod-db");
    // The evidence travels with the finding, so an agent can tell proof from inference.
    expect(json.projectName.misnamed[0]?.owner).toBe("oldname");
    expect(json.projectName.detail).toContain("stamped");
  });
});

describe("dev login", () => {
  const prefs =
    (over: Partial<DoctorReport["devPreferences"] & object> = {}) =>
    async () => ({
      state: "absent" as const,
      path: "/home/u/.config/pithy/acme/dev.json",
      user: null,
      ...over,
    });

  test("names the resolved path, tilde-abbreviated, beside the other config paths", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDevPreferences: prefs() }));
    expect(renderDoctorText(report, "/home/u")).toContain(
      "Dev login:  ~/.config/pithy/acme/dev.json — none yet; sign-in stays magic-link only",
    );
  });

  test("no file never fails the exit — a magic-link-only project is the documented default", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDevPreferences: prefs() }));
    expect(doctorExitCode(report)).toBe(0);
  });

  test("a healthy file names its user and still does not fail the exit", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkDevPreferences: prefs({ state: "ok", user: "ada@example.com" }) }),
    );
    expect(doctorExitCode(report)).toBe(0);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Dev login:  ~/.config/pithy/acme/dev.json — names ada@example.com");
    // Doctor runs no seed, so it must never imply it checked the roster.
    expect(text).not.toContain("seeded");
  });

  test("a file that will not parse fails the exit and drags the report verbose", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({ checkDevPreferences: prefs({ state: "unparseable" }) }),
    );
    expect(doctorExitCode(report)).toBe(1);
    expect(renderDoctorText(report, "/home/u")).toContain("Dev login:  ~/.config/pithy/acme/dev.json — will not parse");
  });

  test("a file naming no user fails the exit too", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({ checkDevPreferences: prefs({ state: "no-user" }) }),
    );
    expect(doctorExitCode(report)).toBe(1);
    expect(renderDoctorText(report, "/home/u")).toContain('no "user"');
  });

  test("a healthy file keeps the terse report terse — it has nothing to say", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({ checkDevPreferences: prefs({ state: "ok", user: "ada@example.com" }) }),
    );
    expect(renderDoctorText(report, "/home/u")).not.toContain("Dev login:");
  });

  test("outside a project there is no line at all — no config, no per-project path", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDevPreferences: async () => null }));
    expect(report.devPreferences).toBeNull();
    expect(renderDoctorText(report, "/home/u")).not.toContain("Dev login:");
    expect((renderDoctorJson(report) as { devPreferences: unknown }).devPreferences).toBeNull();
  });

  test("--json carries the absolute path, the state, and the user the file names", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkDevPreferences: prefs({ state: "ok", user: "ada@example.com" }) }),
    );
    const json = renderDoctorJson(report) as {
      devPreferences: { state: string; path: string; user: string | null; detail: string };
    };
    expect(json.devPreferences).toEqual({
      state: "ok",
      path: "/home/u/.config/pithy/acme/dev.json",
      user: "ada@example.com",
      detail: "names ada@example.com",
    });
  });
});

/**
 * The port registry's contents, not just its address (#436). The defect: `Ports:` named a file in
 * `~/.config` and nothing read it back, so "why is this project on 8847" had no answer short of `cat`.
 */
describe("port registry listing", () => {
  const ACME = "/home/u/code/acme";
  const OTHER = "/home/u/code/other-app";

  const entry = (over: Partial<PortsRegistryEntry> & { base: number }): PortsRegistryEntry => ({
    root: ACME,
    branch: "main",
    block: 0,
    size: 20,
    own: true,
    onDisk: true,
    ...over,
  });

  const ports =
    (over: Partial<PortsRegistryCheck> = {}) =>
    async () => ({
      path: "/home/u/.config/pithy/dev-ports.json",
      present: true,
      stray: null,
      root: ACME,
      unreadable: null,
      entries: [],
      ...over,
    });

  test("prints this checkout's blocks as ranges, unqualified, under the path", async () => {
    // Ranges, not block indices: a registry written before BLOCK_SIZE changed holds mixed widths, and
    // indices hide exactly the overlap the allocator compares ranges to survive.
    const report = await buildDoctorReport(
      baseOptions({
        checkPortsRegistry: ports({
          entries: [entry({ base: 8787 }), entry({ branch: "feature/12-auth", block: 1, base: 8807 })],
        }),
      }),
    );
    expect(renderDoctorText(report, "/home/u")).toContain(
      [
        "Ports:      ~/.config/pithy/dev-ports.json",
        "            8787–8806  main",
        "            8807–8826  feature/12-auth",
      ].join("\n"),
    );
  });

  test("names the checkout that holds every other block", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkPortsRegistry: ports({
          entries: [entry({ base: 8787 }), entry({ root: OTHER, block: 2, base: 8827, own: false })],
        }),
      }),
    );
    expect(renderDoctorText(report, "/home/u")).toContain("            8827–8846  ~/code/other-app — main");
  });

  test("names a root that is gone from disk, before anything prunes it", async () => {
    // The one line here a developer can act on: you renamed that directory, and the next allocation by
    // any project on this machine frees these ports without a word.
    const report = await buildDoctorReport(
      baseOptions({
        checkPortsRegistry: ports({
          entries: [entry({ root: "/home/u/code/old-thing", block: 8, base: 8947, own: false, onDisk: false })],
        }),
      }),
    );
    expect(renderDoctorText(report, "/home/u")).toContain(
      "            8947–8966  ~/code/old-thing — main  ← not on disk",
    );
  });

  test("aligns the range column against the widest range, mixed widths included", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkPortsRegistry: ports({
          entries: [entry({ base: 8787, size: 10 }), entry({ root: OTHER, block: 1, base: 9987, own: false })],
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("            8787–8796   main");
    expect(text).toContain("            9987–10006  ~/code/other-app — main");
  });

  test("a registry with nothing in it is the path and nothing else", async () => {
    const report = await buildDoctorReport(baseOptions({ checkPortsRegistry: ports() }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Ports:      ~/.config/pithy/dev-ports.json\nNotifier:");
  });

  test("a registry nothing could read says so instead of listing nothing", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkPortsRegistry: ports({
          unreadable:
            "The port registry is corrupt. Delete /home/u/.config/pithy/dev-ports.json and re-run pithy feature create to rebuild it.",
        }),
      }),
    );
    expect(renderDoctorText(report, "/home/u")).toContain(
      "Ports:      ~/.config/pithy/dev-ports.json — could not be read. The port registry is corrupt. Delete /home/u/.config/pithy/dev-ports.json and re-run pithy feature create to rebuild it.",
    );
  });

  test("nothing here can fail the exit — a stale root is information, not drift", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({
        checkPortsRegistry: ports({
          unreadable: "The port registry is corrupt. Delete it and re-run pithy feature create to rebuild it.",
          stray: "/p/.dev-ports.json",
          entries: [entry({ base: 8787, own: false, onDisk: false })],
        }),
      }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });

  test("--json carries the whole registry with absolute, unabbreviated paths", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        checkPortsRegistry: ports({
          entries: [entry({ base: 8787 }), entry({ root: OTHER, block: 2, base: 8827, own: false, onDisk: false })],
        }),
      }),
    );
    const json = renderDoctorJson(report) as { portsRegistry: PortsRegistryCheck & { detail: string | null } };
    expect(json.portsRegistry).toEqual({
      path: "/home/u/.config/pithy/dev-ports.json",
      present: true,
      stray: null,
      root: ACME,
      unreadable: null,
      detail: null,
      entries: [
        { root: ACME, branch: "main", block: 0, base: 8787, size: 20, own: true, onDisk: true },
        { root: OTHER, branch: "main", block: 2, base: 8827, size: 20, own: false, onDisk: false },
      ],
    });
  });

  test("the terse report carries no listing — it is not a fault", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({ checkPortsRegistry: ports({ entries: [entry({ base: 8787 })] }) }),
    );
    expect(renderDoctorText(report, "/home/u")).not.toContain("8787–8806");
  });
});

/**
 * The `.dev.vars` files, and the state #178 was reported from: a project whose Worker was getting
 * nothing while `doctor` called it healthy. Reported, never gated — but never silent either.
 */
describe("dev vars", () => {
  const devVars =
    (over: Partial<DoctorReport["devVars"] & object> = {}) =>
    async () => ({
      root: [],
      empty: [],
      minted: [],
      devJsonSecrets: [],
      devConfigPath: "/home/u/.config/pithy/acme/dev.json",
      mintedTokensPath: "/home/u/.config/pithy/acme/tokens.json",
      unresolvable: [],
      ...over,
    });

  test("an empty generated file names the Worker and drags the report verbose", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({
        checkDevVars: devVars({ empty: [{ worker: "board", file: "apps/board/.dev.vars" }] }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Dev secrets:");
    expect(text).toContain("board has no dev values");
    expect(text).toContain("apps/board/.dev.vars");
    // Worth the ink, not worth a red CI: every project that predates the generated file starts here.
    expect(doctorExitCode(report)).toBe(0);
    expect(text).toContain("Config dir:");
  });

  test("a key nothing reads is named, and so is a credential left in the checkout beside it", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({
        checkDevVars: devVars({
          root: [
            { key: "CLOUDFLARE_API_TOKEN", state: "credential", workers: [] },
            { key: "LEFTOVER_FROM_2024", state: "unread", workers: [] },
          ],
        }),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("LEFTOVER_FROM_2024 is in .dev.vars and nothing reads it");
    // #182 moved the credentials to `<config>/cloudflare.json`, so this copy is a live token in a
    // checkout that nothing reads. It was the one silent class here; it is not any more.
    expect(text).toContain("CLOUDFLARE_API_TOKEN is in .dev.vars, which nothing reads now");
  });

  test("a healthy project says nothing and stays terse", async () => {
    const report = await buildDoctorReport(harness.healthyOptions({ checkDevVars: devVars() }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).not.toContain("Dev secrets:");
    expect(text).not.toContain("Config dir:");
  });

  test("outside a project the question is never asked", async () => {
    const probe = vi.fn(devVars());
    const report = await buildDoctorReport(
      harness.healthyOptions({ loadProject: undefined, checkDevVars: probe as DoctorReportOptions["checkDevVars"] }),
    );
    expect(report.devVars).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  test("--json carries the whole classification, names only", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({
        checkDevVars: devVars({
          root: [{ key: "SECRETS_ENCRYPTION_KEYS", state: "binding", workers: ["board"] }],
          empty: [{ worker: "board", file: "apps/board/.dev.vars" }],
        }),
      }),
    );
    const json = renderDoctorJson(report) as { devVars: { root: unknown[]; empty: unknown[]; detail: string[] } };
    expect(json.devVars.root).toHaveLength(1);
    expect(json.devVars.empty).toHaveLength(1);
    expect(json.devVars.detail.join("\n")).toContain("SECRETS_ENCRYPTION_KEYS");
  });
});

/**
 * The `Secrets:` line, which is a **location** rather than a finding — the one line in the report that
 * nothing else in the toolchain could tell you. The file is outside every checkout since #156, so a
 * report that omits it leaves an adopter with no way to find it at all, and "where is it" is not a
 * complaint the terse report is entitled to suppress (#166).
 */
describe("dev secrets file", () => {
  const location =
    (over: Partial<DoctorReport["devSecretsFile"] & object> = {}) =>
    async () => ({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      present: true,
      orphans: [],
      ...over,
    });

  test("prints in the verbose report, beside the other config paths", async () => {
    const report = await buildDoctorReport(baseOptions({ checkDevSecretsFile: location() }));
    expect(renderDoctorText(report, "/home/u")).toContain(
      "Secrets:    ~/.config/pithy/acme/secrets.jsonc (run `pithy secrets edit`)",
    );
  });

  /**
   * The command, not only the path. The file is outside the checkout, so nothing an adopter can browse
   * leads to it and this line is the only place the toolchain names either one (#186).
   */
  test("names the command that opens it, in both forms of the report", async () => {
    const verbose = await buildDoctorReport(baseOptions({ checkDevSecretsFile: location() }));
    const terse = await buildDoctorReport(harness.healthyOptions({ checkDevSecretsFile: location() }));
    for (const report of [verbose, terse]) {
      expect(renderDoctorText(report, "/home/u")).toContain("(run `pithy secrets edit`)");
    }
  });

  test("prints in the terse report too — a healthy project is the one most likely to be asking", async () => {
    const report = await buildDoctorReport(harness.healthyOptions({ checkDevSecretsFile: location() }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).toBe(
      [
        "",
        "pithy 1.3.0 (installed via brew)",
        "Up to date.",
        "",
        "Shell: zsh",
        "Alias: installed",
        "",
        "Secrets: ~/.config/pithy/acme/secrets.jsonc (run `pithy secrets edit`)",
        "",
        "Project: pithy.config.ts found",
        "Project capabilities: all up to date",
        "",
        "Cloudflare: token active; checked: API tokens — no other product was reached",
        "",
        "OS:      macOS 14.5",
        "Runtime: Node 22.10.0",
      ].join("\n"),
    );
    // A path is not a fault: naming it must not gate CI, and must not drag the rest of the report out.
    expect(doctorExitCode(report)).toBe(0);
    expect(text).not.toContain("Config dir:");
  });

  /**
   * The rename trail, in the only report that can carry it. `devSecretsFile` is deliberately not a term
   * in the terse predicate, so a project whose *only* anomaly is a renamed or duplicated config directory
   * renders terse — and before #166 that put the trail out of reach in exactly the case it was written for.
   */
  test("a renamed project's trail prints in the terse report", async () => {
    const report = await buildDoctorReport(
      harness.healthyOptions({ checkDevSecretsFile: location({ present: false, orphans: ["acme-old"] }) }),
    );
    expect(renderDoctorText(report, "/home/u")).toContain(
      "Secrets: ~/.config/pithy/acme/secrets.jsonc (run `pithy secrets edit`) — no file yet; secrets exist for acme-old — a renamed project leaves its old name here",
    );
  });

  test("outside a project there is no line at all — no config, no name to key a path on", async () => {
    const report = await buildDoctorReport(harness.healthyOptions({ checkDevSecretsFile: async () => null }));
    expect(report.devSecretsFile).toBeNull();
    expect(renderDoctorText(report, "/home/u")).not.toContain("Secrets:");
  });
});

describe("worker names", () => {
  /** The hand-rename the dashboard did: `apps/board`, still deploying and stamping as `api`. */
  const handRenamed = {
    state: "drifted" as const,
    mismatches: [
      { worker: "board", stamp: "name" as const, declared: "acme-api", expected: "acme-board", envs: [] },
      {
        worker: "board",
        stamp: "vars.WORKER" as const,
        declared: "api",
        expected: "board",
        envs: ["dev", "staging", "prod"],
      },
    ],
  };

  test("agreeing names stay out of the terse report and do not fail the exit", async () => {
    const report = await buildDoctorReport(healthyOptions());
    expect(report.workerNames?.state).toBe("ok");
    expect(doctorExitCode(report)).toBe(0);
    expect(renderDoctorText(report, "/home/u")).not.toContain("Worker names:");
  });

  test("a hand-rename fails the exit, so CI catches the stamp nobody remembered", async () => {
    const report = await buildDoctorReport(baseOptions({ checkWorkerNames: async () => handRenamed }));
    expect(doctorExitCode(report)).toBe(1);
    // Pinned whole, on the health block's columns: a diagnostic's layout is what makes it readable at a
    // glance, and every other block here is pinned the same way.
    expect(renderDoctorText(report, "/home/u")).toContain(
      [
        "Worker names:",
        "  board:",
        "    name         deploys as acme-api, not acme-board",
        "    vars.WORKER  stamps events as api, not board",
        "                 env: dev, staging, prod",
        "    Make wrangler.jsonc agree with the directory. Next time: pithy worker rename.",
      ].join("\n"),
    );
  });

  test("could-not-check never fails the exit — an unreadable config establishes nothing", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkWorkerNames: async () => ({ state: "could-not-check", mismatches: [] }) }),
    );
    expect(doctorExitCode(report)).toBe(0);
  });

  test("outside a project there are no workers to name", async () => {
    const report = await buildDoctorReport(
      baseOptions({
        loadProject: async () => {
          throw new NotFoundError({ message: "No pithy.config.ts here." });
        },
      }),
    );
    expect(report.workerNames).toBeNull();
    expect(renderDoctorJson(report).workerNames).toBeNull();
  });

  test("--json carries every mismatch, so an agent can fix them without parsing columns", async () => {
    const report = await buildDoctorReport(baseOptions({ checkWorkerNames: async () => handRenamed }));
    const json = renderDoctorJson(report) as {
      workerNames: { state: string; mismatches: { worker: string; stamp: string; detail: string }[] };
    };
    expect(json.workerNames.state).toBe("drifted");
    expect(json.workerNames.mismatches).toHaveLength(2);
    expect(json.workerNames.mismatches[0]?.detail).toBe("deploys as acme-api, not acme-board");
  });
});

describe("runtime reporting", () => {
  test("Bun is named as the runtime, with the Node level it emulates", () => {
    expect(detectRuntime({ bun: "1.1.38", node: "22.6.0" } as unknown as NodeJS.ProcessVersions)).toEqual({
      name: "Bun",
      version: "1.1.38",
      nodeCompat: "22.6.0",
    });
  });

  test("plain Node reports itself with no compat level", () => {
    expect(detectRuntime({ node: "22.10.0" } as unknown as NodeJS.ProcessVersions)).toEqual({
      name: "Node",
      version: "22.10.0",
      nodeCompat: null,
    });
  });

  test("the report names the interpreter rather than the emulated Node version", async () => {
    const report = await buildDoctorReport(
      baseOptions({ runtime: { name: "Bun", version: "1.1.38", nodeCompat: "22.6.0" } }),
    );
    expect(renderDoctorText(report, "/home/u")).toContain("Runtime: Bun 1.1.38 (Node 22.6.0 compat)");
  });
});

describe("version checks that could not run", () => {
  /** A registry that answers nothing — offline, an outage, or a package not published yet. */
  const silentRegistry: FetchLike = vi.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  })) as FetchLike;

  test("an unreachable registry is unknown, never current", async () => {
    const report = await buildDoctorReport(baseOptions({ fetch: silentRegistry }));
    expect(report.cli.state).toBe("unknown");
    expect(report.project?.capabilities.every((cap) => cap.state === "unknown")).toBe(true);
  });

  test("the report says the check was unavailable rather than claiming currency", async () => {
    const report = await buildDoctorReport(baseOptions({ fetch: silentRegistry }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Version check unavailable (registry unreachable).");
    expect(text).toContain("Project capabilities: version check unavailable (registry unreachable)");
    expect(text).not.toContain("Up to date.");
    expect(text).not.toContain("all up to date");
  });

  test("not knowing never fails the exit — it is absence of information, not drift", async () => {
    const report = await buildDoctorReport(baseOptions({ fetch: silentRegistry }));
    expect(doctorExitCode(report)).toBe(0);
  });

  test("versionState classifies each case", () => {
    expect(versionState("1.2.0", null)).toBe("unknown");
    expect(versionState("1.2.0", "1.2.0")).toBe("current");
    expect(versionState("1.2.0", "1.3.0")).toBe("outdated");
  });
});

/**
 * The finding `pithy doctor` did not report.
 *
 * `availableManifests` skipped a manifest that was present and invalid exactly as it skips a package that
 * ships none, so the capability was absent from every check the health block runs and the block said the
 * project was healthy. Doctor is one of the three commands an adopter runs when a capability has gone
 * missing, and it was one of the three that stayed silent (#184).
 */
describe("manifest faults in the health block", () => {
  /** Install a manifest the schema refuses into the report's own project directory. */
  async function installBrokenManifest(): Promise<void> {
    const pkgDir = join(dir, "node_modules", "@pithy-sh", "audit");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "pithy.manifest.json"),
      JSON.stringify({
        name: "audit",
        package: "@pithy-sh/audit",
        requiredBindings: [],
        configOptions: [{ key: "content-type", default: "x", describe: "Not a bare key." }],
      }),
    );
  }

  test("names the package and the reason, and fails the exit", async () => {
    await installBrokenManifest();
    const report = await buildDoctorReport(healthyOptions({ buildPlan: planStub(cleanPlan) }));

    expect(report.project?.health.manifests.ok).toBe(false);
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("@pithy-sh/audit");
    expect(text).toContain("malformed pithy.manifest.json");
    expect(text).toContain("configOptions[0].key");
    // The Worker itself is clean; the project is not, and CI can gate on it.
    expect(report.project?.health.workers.every((worker) => worker.state === "checked" && worker.ok)).toBe(true);
    expect(doctorExitCode(report)).toBe(1);
  });

  test("a package that ships no manifest is still skipped in silence", async () => {
    await mkdir(join(dir, "node_modules", "@pithy-sh", "cli"), { recursive: true });
    const report = await buildDoctorReport(healthyOptions({ buildPlan: planStub(cleanPlan) }));
    expect(report.project?.health.manifests).toEqual({ ok: true, faults: [] });
    expect(doctorExitCode(report)).toBe(0);
  });
});

/**
 * One optional line's failure must not cost every other line (#210).
 *
 * `doctor` deliberately discards read failures — a diagnostic has to work in the environment it
 * diagnoses — and the shell rc read was the one that did not follow the rule. An unreadable `~/.bashrc`
 * threw out of `buildDoctorReport` and the whole report went with it: Cloudflare reachability, the
 * secrets paths, project health, dev secrets. The least important line in the report took the other
 * twenty with it.
 *
 * Catching it to `false` is not the fix and is why #203 left it alone: `Alias: not installed` about a
 * file nothing could read is a lie, and the adopter's next move is `pithy alias`, which fails on the
 * same file. The field is tri-state, and the third state names the file.
 */
describe("one unreadable file must not cost the whole report (#210)", () => {
  /** The refusal `readRcFile` raises for a file that is there and will not open. */
  const unreadableRc = async (path: string): Promise<string> => {
    throw new ConflictError({
      message: `Can't read ${path}.`,
      action: "Fix the file's permissions, or add the Pithy alias to your shell config yourself.",
      detail: `EACCES while reading ${path}`,
    });
  };

  test("an unreadable rc file produces a report, not an exception", async () => {
    const report = await buildDoctorReport(healthyOptions({ readRc: unreadableRc }));

    // Everything the crash used to take with it is still here.
    expect(report.cloudflare.state).toBe("ok");
    expect(report.project).not.toBeNull();
    expect(report.os).toEqual({ name: "macOS", version: "14.5" });
  });

  test("the alias status is unknown, and names the file — never 'not installed'", async () => {
    const report = await buildDoctorReport(healthyOptions({ readRc: unreadableRc }));

    expect(report.alias.state).toBe("unknown");
    expect(report.alias.rcPath).toBe("/home/u/.zshrc");
    expect(report.alias.reason).toContain("Can't read /home/u/.zshrc.");

    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Alias: unknown — can't read ~/.zshrc");
    expect(text).not.toContain("Alias: not installed");
  });

  test("an unknown alias keeps the report verbose — 'I could not check' is worth the ink", async () => {
    const report = await buildDoctorReport(healthyOptions({ readRc: unreadableRc }));
    // The terse report drops the rc path from the `Shell:` line. A state nobody established must not
    // be reported in the form that says there is nothing to look at.
    expect(renderDoctorText(report, "/home/u")).toContain("Shell: zsh (~/.zshrc)");
  });

  test("--json carries the third state, and the two ordinary ones keep their shape", async () => {
    const unknown = renderDoctorJson(await buildDoctorReport(healthyOptions({ readRc: unreadableRc })));
    expect(unknown.alias).toEqual({
      state: "unknown",
      rcPath: "/home/u/.zshrc",
      reason: expect.stringContaining("Can't read /home/u/.zshrc."),
    });

    const installed = renderDoctorJson(await buildDoctorReport(healthyOptions()));
    expect(installed.alias).toEqual({ state: "installed", rcPath: "/home/u/.zshrc", reason: null });

    const absent = renderDoctorJson(await buildDoctorReport(healthyOptions({ readRc: async () => "" })));
    expect(absent.alias).toEqual({ state: "not-installed", rcPath: "/home/u/.zshrc", reason: null });
  });

  test("an alias nobody could read never fails the exit — toolchain state never does", async () => {
    const report = await buildDoctorReport(healthyOptions({ readRc: unreadableRc }));
    expect(doctorExitCode(report)).toBe(0);
  });

  /**
   * The general case, which is the point rather than the rc file. `doctor` also *writes* one file — the
   * notifier cache — and a config directory it cannot write to is exactly the machine somebody runs
   * `doctor` on. That write is bookkeeping for the next run; it must not cost this one its report.
   */
  test("a config directory that cannot be written still produces a report", async () => {
    const readOnly = join(dir, "read-only");
    await mkdir(readOnly, { recursive: true });
    await chmod(readOnly, 0o500);
    try {
      const report = await buildDoctorReport(healthyOptions({ stateFile: join(readOnly, "state.json") }));
      expect(report.cli.installed).toBe("1.3.0");
      expect(report.project).not.toBeNull();
    } finally {
      await chmod(readOnly, 0o700);
    }
  });

  /**
   * Every file the real checks read, made unreadable one at a time against a real scaffold.
   *
   * The rule is not "doctor should catch more" — it is that no single read may cost every other line, and
   * the only way to know that is to break each of them. Every seam here is the real function: stubbing
   * them would test the stubs.
   */
  test("no single unreadable file in a real project prevents the report", async () => {
    const projectDir = join(dir, "unreadable");
    await scaffoldProject({ targetDir: projectDir, appName: "replay", worker: "board" });
    const worker = join(projectDir, "apps", "board");
    await writeFile(join(projectDir, ".dev.vars"), "OLD_FLAG=1\n");
    await writeFile(join(worker, ".dev.vars.local"), "LOCAL_ONLY=1\n");

    const files = [
      join(projectDir, ".dev.vars"),
      join(worker, ".dev.vars.local"),
      join(worker, "wrangler.jsonc"),
      join(worker, "pithy.worker.jsonc"),
      join(worker, "pithy.config.ts"),
      join(projectDir, "pithy.config.ts"),
    ];

    for (const file of files) {
      await chmod(file, 0o000);
      try {
        const report = await buildDoctorReport(
          baseOptions({
            projectDir,
            buildPlan: planStub(cleanPlanFor("board")),
            resolveWorkers: undefined,
            // The real name check too — it reads every `wrangler.jsonc` in the project, and with no
            // credentials resolved (`NO_ACCOUNT`) it never reaches an account. Only the Cloudflare probe
            // stays stubbed, because that one is the network.
            checkProjectName: undefined,
          }),
        );
        expect(report.os, `${file} took the report with it`).toEqual({ name: "macOS", version: "14.5" });
      } finally {
        await chmod(file, 0o644);
      }
    }
  });
});

/**
 * A Worker nobody could ask, in the report (#208).
 *
 * The `Dev secrets:` block used to disappear entirely when every `pithy.config.ts` failed to import: the
 * lossy target list answered `[]`, `checkDevSecrets` read that as "no Worker composes secrets" and
 * returned `null`, and the report went quiet in the one state it was written for. Same shape as #166 —
 * a line that vanishes in the report that needed it.
 */
describe("a Worker nobody could ask, in the report (#208)", () => {
  const broken = [
    { name: "replay-board", dir: "/p/apps/board", reason: "apps/board/pithy.config.ts would not import. Fix it." },
  ];

  const options = () =>
    harness.healthyOptions({
      checkDevVars: async () => ({
        root: [{ key: "MYSTERY_KEY", state: "unclassified" as const, workers: [] }],
        empty: [],
        minted: [],
        devJsonSecrets: [],
        devConfigPath: "/home/u/.config/pithy/acme/dev.json",
        mintedTokensPath: "/home/u/.config/pithy/acme/tokens.json",
        unresolvable: broken,
      }),
      checkDevSecrets: async () => ({
        path: "/home/u/.config/pithy/acme/secrets.jsonc",
        misplaced: [],
        missing: [],
        bootstrapMissing: [],
        bootstrapUnmintable: [],
        malformed: [],
        undeclared: [],
        mode: null,
        unreadable: null,
        unresolvable: broken,
      }),
    });

  test("the block prints, names the Worker, and never says the value can go", async () => {
    const text = renderDoctorText(await buildDoctorReport(options()), "/home/u");

    expect(text).toContain("Dev secrets:");
    expect(text).toContain("replay-board's pithy.config.ts would not import");
    expect(text).toContain("MYSTERY_KEY is in .dev.vars, and nothing here can say what reads it");
    expect(text).not.toContain("Delete it.");
  });

  test("the rest of the report is still there — a diagnostic reports, it does not refuse", async () => {
    const report = await buildDoctorReport(options());
    const text = renderDoctorText(report, "/home/u");

    expect(text).toContain("Cloudflare: token active;");
    expect(text).toContain("Project: pithy.config.ts found");
    expect(text).toContain("OS:      macOS 14.5");
    // Reported, never gated: an unloadable Worker config is the `Project:` block's to fail the exit on.
    expect(doctorExitCode(report)).toBe(0);
  });

  test("--json tells 'no Worker composes secrets' from 'nothing would load'", async () => {
    const named = renderDoctorJson(await buildDoctorReport(options())) as {
      devSecrets: { unresolvable: { name: string }[] };
      devVars: { unresolvable: { name: string }[] };
    };
    expect(named.devSecrets.unresolvable.map((worker) => worker.name)).toEqual(["replay-board"]);
    expect(named.devVars.unresolvable.map((worker) => worker.name)).toEqual(["replay-board"]);

    // The project with no secrets keeps the shape it always had: one `null`, one fact.
    const quiet = renderDoctorJson(
      await buildDoctorReport(harness.healthyOptions({ checkDevSecrets: async () => null })),
    );
    expect(quiet.devSecrets).toBeNull();
  });
});

/**
 * Every fault the human report shows, in `--json` (#325).
 *
 * `unreadable` became the loader's sentence in #323 and the projection passed it through unchanged, so a
 * CI script gating on `unreadable === true` stopped firing and read a broken secrets file as healthy — a
 * non-empty string is not `false`, it is merely not `true`. `malformed` and `bootstrapMissing` were never
 * projected at all, and `malformed` is the one that flips the exit.
 */
describe("--json carries every dev-secrets fault the text block prints (#325)", () => {
  const faulty = () =>
    harness.healthyOptions({
      checkDevSecrets: async () => ({
        path: "/home/u/.config/pithy/acme/secrets.jsonc",
        misplaced: [],
        missing: [],
        bootstrapMissing: ["SECRETS_ENCRYPTION_KEYS"],
        bootstrapUnmintable: [],
        malformed: [{ name: "auth-google-credentials", reason: "auth-google-credentials is not the shape it needs." }],
        undeclared: [],
        mode: null,
        unreadable: null,
        unresolvable: [],
      }),
    });

  test("a malformed value is in the payload, and so is the bootstrap key nobody minted", async () => {
    const json = renderDoctorJson(await buildDoctorReport(faulty())) as {
      devSecrets: { malformed: { name: string; reason: string }[]; bootstrapMissing: string[]; healthy: boolean };
    };

    expect(json.devSecrets.malformed.map((one) => one.name)).toEqual(["auth-google-credentials"]);
    expect(json.devSecrets.malformed[0]?.reason).toContain("not the shape it needs");
    expect(json.devSecrets.bootstrapMissing).toEqual(["SECRETS_ENCRYPTION_KEYS"]);
  });

  /**
   * The one field a script can gate on without knowing which faults exist. `unreadable === true` was that
   * field and stopped being it silently; this one is computed from `devSecretsHealthy`, the same function
   * the text renderer draws the fault line from, so the two cannot come to two answers.
   */
  test("`healthy` answers the whole question, and agrees with what the text report says", async () => {
    const broken = await buildDoctorReport(faulty());
    const brokenJson = renderDoctorJson(broken) as { devSecrets: { healthy: boolean } };
    expect(brokenJson.devSecrets.healthy).toBe(false);
    expect(renderDoctorText(broken, "/home/u")).toContain("Dev secrets:");

    const fine = await buildDoctorReport(
      harness.healthyOptions({
        checkDevSecrets: async () => ({
          path: "/home/u/.config/pithy/acme/secrets.jsonc",
          misplaced: [],
          missing: [],
          bootstrapMissing: [],
          bootstrapUnmintable: [],
          malformed: [],
          undeclared: [],
          mode: null,
          unreadable: null,
          unresolvable: [],
        }),
      }),
    );
    expect((renderDoctorJson(fine) as { devSecrets: { healthy: boolean } }).devSecrets.healthy).toBe(true);
    expect(renderDoctorText(fine, "/home/u")).not.toContain("Dev secrets:");
  });

  /** A file that will not parse: the sentence is carried, and it is truthy, so a `if (…unreadable)` gate fires. */
  test("an unreadable file carries its sentence and reads as a fault", async () => {
    const json = renderDoctorJson(
      await buildDoctorReport(
        harness.healthyOptions({
          checkDevSecrets: async () => ({
            path: "/home/u/.config/pithy/acme/secrets.jsonc",
            misplaced: [],
            missing: [],
            bootstrapMissing: [],
            bootstrapUnmintable: [],
            malformed: [],
            undeclared: [],
            mode: null,
            unreadable: "secrets.jsonc is not valid JSONC at line 3.",
            unresolvable: [],
          }),
        }),
      ),
    ) as { devSecrets: { unreadable: string | null; healthy: boolean } };

    expect(json.devSecrets.unreadable).toContain("line 3");
    expect(json.devSecrets.healthy).toBe(false);
  });
});
