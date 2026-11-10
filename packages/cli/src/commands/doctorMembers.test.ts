// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { doctorFailures } from "../doctor/failures";
import { declaredSpecs } from "../kitPackages/ranges";
import { cleanPlanFor, doctorHarness, planStub, registryFetch } from "../test-utils/doctorHarness";
import { buildDoctorReport, installedCapabilityVersions, renderDoctorText } from "./doctor";

/**
 * **`pithy doctor` over a capability installed only in a Worker's own `node_modules`**, through its default seams.
 *
 * `pithy add` installs into the Worker's workspace member, so the manifest scan and the shared-runtime check read
 * every member. Bun's isolated linker leaves a member's dependency as a link into the root's `.bun` store, and the
 * capability's own dependencies sit beside it there.
 */

const h = doctorHarness();

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

/** A package at `dir` that node resolves: a `package.json` naming its entry, and the entry. */
async function resolvable(dir: string, name: string): Promise<void> {
  await writeJson(join(dir, "package.json"), { name, version: "1.0.0", main: "index.js" });
  await writeFile(join(dir, "index.js"), "module.exports = {};\n");
}

/** A workspace root with the one member `apps/api`. */
async function workspace(): Promise<string> {
  await writeJson(join(h.dir, "package.json"), { name: "root", private: true, workspaces: ["apps/*"] });
  const api = join(h.dir, "apps", "api");
  await writeJson(join(api, "package.json"), { name: "api" });
  return api;
}

/** Put `@pithy-sh/<name>` in the `.bun` store, with `files` in it, and link it into `member`'s `node_modules`. */
async function linkFromStore(member: string, name: string, files: Record<string, string>): Promise<string> {
  const store = join(h.dir, "node_modules", ".bun", `@pithy-sh+${name}@1.0.0`, "node_modules");
  const home = join(store, "@pithy-sh", name);
  await writeJson(join(home, "package.json"), { name: `@pithy-sh/${name}`, version: "1.0.0" });
  for (const [file, text] of Object.entries(files)) await writeFile(join(home, file), text);
  const at = join(member, "node_modules", "@pithy-sh", name);
  await mkdir(dirname(at), { recursive: true });
  await symlink(relative(dirname(at), home), at);
  return store;
}

describe("pithy doctor reads every workspace member by default", () => {
  test("a malformed manifest installed only under apps/api/node_modules fails the manifests line", async () => {
    const api = await workspace();
    await linkFromStore(api, "audit", { "pithy.manifest.json": "{ not json" });

    const report = await buildDoctorReport(h.baseOptions());

    expect(report.project?.health.manifests.faults.map((fault) => fault.package)).toEqual(["@pithy-sh/audit"]);
    expect(report.project?.health.manifests.ok).toBe(false);
  });

  test("a second zod beside a capability linked into apps/api is a duplicated shared runtime", async () => {
    const api = await workspace();
    await resolvable(join(h.dir, "node_modules", "zod"), "zod");
    const store = await linkFromStore(api, "auth", {});
    await resolvable(join(store, "zod"), "zod");

    const report = await buildDoctorReport(h.baseOptions());

    expect(report.sharedRuntimes?.duplicated.map((one) => one.name)).toEqual(["zod"]);
  });
});

describe("pithy doctor's package advice judges a linked checkout as --packages does", () => {
  /** A workspace whose `apps/api` alone declares `@pithy-sh/secrets` at `^1.0.0`. */
  async function apiDeclaresSecrets(): Promise<string> {
    const api = await workspace();
    await writeJson(join(api, "package.json"), { name: "api", dependencies: { "@pithy-sh/secrets": "^1.0.0" } });
    return api;
  }

  /**
   * The report's line for `@pithy-sh/secrets`, with `1.1.0` the registry's latest. What is installed and what is
   * declared are read from disk by doctor's own readers, not the harness's fixed lists.
   */
  async function secretsLine() {
    const report = await buildDoctorReport(
      h.baseOptions({
        fetch: registryFetch({ cli: "1.3.0", secrets: "1.1.0" }),
        installedCapabilities: installedCapabilityVersions,
        declaredSpecs,
      }),
    );
    return report.project?.capabilities.find((cap) => cap.name === "@pithy-sh/secrets");
  }

  test("a package only apps/api declares, linked there from a checkout, is advised as linked", async () => {
    const api = await apiDeclaresSecrets();
    const checkout = join(h.dir, "checkout", "secrets");
    await writeJson(join(checkout, "package.json"), { name: "@pithy-sh/secrets", version: "1.0.0" });
    const at = join(api, "node_modules", "@pithy-sh", "secrets");
    await mkdir(dirname(at), { recursive: true });
    await symlink(relative(dirname(at), checkout), at);

    const secrets = await secretsLine();

    expect(secrets?.state).toBe("outdated");
    expect(secrets?.reason).toBe("linked");
    expect(secrets?.command).toBeNull();
  });

  test("the same package installed in apps/api from the store is advised the --packages move", async () => {
    const api = await apiDeclaresSecrets();
    await linkFromStore(api, "secrets", {});

    const secrets = await secretsLine();

    expect(secrets?.state).toBe("outdated");
    expect(secrets?.reason).toBeNull();
    expect(secrets?.command).toBe("pithy upgrade --packages");
  });
});

describe("pithy doctor's add commands read the manifest the Worker resolves", () => {
  test("the entitlement line names payments with the options apps/api's own install states", async () => {
    const api = await workspace();
    await writeJson(join(api, "node_modules", "@pithy-sh", "payments", "pithy.manifest.json"), {
      name: "payments",
      configOptions: [{ key: "region", choices: ["eu"] }],
    });
    const gated = { ...cleanPlanFor("api"), entitlements: { state: "read" as const, gates: ["src/pro.ts"] } };

    const report = await buildDoctorReport(h.baseOptions({ buildPlan: planStub(gated) }));

    const example = "`pithy add payments --worker api --set region=eu`";
    expect(
      doctorFailures(report)
        .map((failure) => failure.detail)
        .join("\n"),
    ).toContain(example);
    expect(renderDoctorText(report)).toContain(example);
  });
});
