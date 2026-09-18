// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { templateTarball } from "../test-utils/templateTarball";
import type { PackagePlan } from "./plan";
import type { Packument, RegistryFetch, RegistryResponse } from "./registry";
import { classifyTemplates, type TemplateTree, templateSections, templateTargets } from "./templates";

const UI = "@pithy-sh/ui-react";
const CLI = "@pithy-sh/cli";

/**
 * The template trees, built from the verified diff of the published tarballs: `router.tsx` identical in all
 * three, `sign-in.tsx` still reading `signup_disabled` in 0.3.0 and moved to `provider_sign_in_refused` in
 * 0.3.1, `client-env.d.ts` gaining `providerSignUp`, `pithy-screens.css` restyled, and the chooser new in
 * 0.3.1.
 */
const ROUTER = 'export const router = "__PITHY_WORKER__";\n';
const V020: TemplateTree = new Map([
  ["src/router.tsx", ROUTER],
  ["src/routes/pithy/sign-in.tsx", 'if (code === "signup_disabled") refuse(); // 0.2.0\n'],
  ["client-env.d.ts", "interface Env { magicLink: boolean }\n"],
  ["src/pithy-screens.css", ".stack { gap: 1rem }\n"],
  ["src/routes/app/home.tsx", "export const Home = guarded;\n"],
  ["src/routes/app/home.bare.tsx", "export const Home = bare;\n"],
]);
const V030: TemplateTree = new Map([
  ...V020,
  ["src/routes/pithy/sign-in.tsx", 'if (code === "signup_disabled") refuse(); // 0.3.0\n'],
]);
const V031: TemplateTree = new Map([
  ...V030,
  ["src/routes/pithy/sign-in.tsx", 'if (code === "provider_sign_in_refused") refuse();\n'],
  ["client-env.d.ts", "interface Env { magicLink: boolean; providerSignUp: boolean }\n"],
  ["src/pithy-screens.css", ".stack { gap: 1.25rem }\n"],
  ["src/routes/pithy/choose-organization.tsx", "export const Chooser = true;\n"],
  ["src/routes/pithy/choose-organization.test.tsx", "test('chooser');\n"],
]);

/** The dashboard's Worker, as it is: every copy edited, no stylesheet, no chooser. */
const BOARD = new Map([
  ["src/routes/pithy/sign-in.tsx", "export function SignIn() { return <Wrapped />; } // 42 lines\n"],
  ["client-env.d.ts", "interface Env { magicLink: boolean; custom: true }\n"],
  ["src/router.tsx", "export const router = drifted;\n"],
]);

const classify = (options: { from?: [string, TemplateTree][]; to?: TemplateTree; files?: Map<string, string> }) =>
  classifyTemplates({
    from: new Map(
      options.from ?? [
        ["0.2.0", V020],
        ["0.3.0", V030],
      ],
    ),
    to: { version: "0.3.1", tree: options.to ?? V031 },
    workers: [{ name: "board", files: options.files ?? BOARD }],
  });

describe("classifyTemplates", () => {
  test("names the edited copies and the new files, and stays silent about router.tsx and the stylesheet", () => {
    expect(classify({})).toEqual([
      { worker: "board", path: "client-env.d.ts", change: "changed", copy: "edited" },
      { worker: "board", path: "src/routes/pithy/sign-in.tsx", change: "changed", copy: "edited" },
      { worker: "board", path: "src/routes/pithy/choose-organization.test.tsx", change: "added", copy: "absent" },
      { worker: "board", path: "src/routes/pithy/choose-organization.tsx", change: "added", copy: "absent" },
    ]);
  });

  test("plant: a router.tsx that did change upstream is named — the silence above is the diff's, not a blind spot", () => {
    const planted = new Map(V031);
    planted.set("src/router.tsx", ROUTER.replace("router", "rOuter"));
    expect(classify({ to: planted })).toContainEqual({
      worker: "board",
      path: "src/router.tsx",
      change: "changed",
      copy: "edited",
    });
  });

  test("a copy byte-equal to 0.2.0's rendered template is untouched, from 0.2.0", () => {
    const files = new Map([["src/routes/pithy/sign-in.tsx", V020.get("src/routes/pithy/sign-in.tsx") ?? ""]]);
    expect(classify({ files }).filter((finding) => finding.change === "changed")).toEqual([
      { worker: "board", path: "src/routes/pithy/sign-in.tsx", change: "changed", copy: "untouched", from: "0.2.0" },
    ]);
  });

  test("the worker token is rendered before comparing", () => {
    const tree = (router: string): TemplateTree => new Map([["src/router.tsx", router]]);
    const findings = classifyTemplates({
      from: new Map([["0.2.0", tree(ROUTER)]]),
      to: { version: "0.3.1", tree: tree(`${ROUTER}// new\n`) },
      workers: [{ name: "board", files: new Map([["src/router.tsx", 'export const router = "board";\n']]) }],
    });
    expect(findings).toEqual([
      { worker: "board", path: "src/router.tsx", change: "changed", copy: "untouched", from: "0.2.0" },
    ]);
  });

  test("a copy equal to the target is silent — it is already current", () => {
    const files = new Map([["src/routes/pithy/sign-in.tsx", V031.get("src/routes/pithy/sign-in.tsx") ?? ""]]);
    expect(classify({ files }).some((finding) => finding.path === "src/routes/pithy/sign-in.tsx")).toBe(false);
  });

  test("a CRLF copy of an old template is still named, and a CRLF copy of the target is still current", () => {
    const crlf = (text: string) => text.replace(/\n/g, "\r\n");
    const old = new Map([["src/routes/pithy/sign-in.tsx", crlf(V020.get("src/routes/pithy/sign-in.tsx") ?? "")]]);
    expect(classify({ files: old })).toContainEqual({
      worker: "board",
      path: "src/routes/pithy/sign-in.tsx",
      change: "changed",
      copy: "untouched",
      from: "0.2.0",
    });
    const current = new Map([
      ["src/routes/pithy/sign-in.tsx", `${crlf(V031.get("src/routes/pithy/sign-in.tsx") ?? "")}\r\n`],
    ]);
    expect(classify({ files: current }).some((finding) => finding.path === "src/routes/pithy/sign-in.tsx")).toBe(false);
  });

  test("home.bare.tsx is compared at home.tsx, per source", () => {
    const to = new Map(V031);
    to.set("src/routes/app/home.bare.tsx", "export const Home = bareV2;\n");
    const bare = new Map([["src/routes/app/home.tsx", "export const Home = bare;\n"]]);
    expect(classify({ to, files: bare }).filter((finding) => finding.path.startsWith("src/routes/app"))).toEqual([
      { worker: "board", path: "src/routes/app/home.tsx", change: "changed", copy: "untouched", from: "0.3.0" },
    ]);
    // The guarded home did not change, so a copy of it is current whatever the bare one did.
    const guarded = new Map([["src/routes/app/home.tsx", "export const Home = guarded;\n"]]);
    expect(classify({ to, files: guarded }).some((finding) => finding.path.startsWith("src/routes/app"))).toBe(false);
  });

  test("a file gone from the target and still in the Worker is removed", () => {
    const to = new Map(V031);
    to.delete("src/pithy-screens.css");
    const files = new Map([["src/pithy-screens.css", ".mine {}\n"]]);
    expect(classify({ to, files })).toContainEqual({
      worker: "board",
      path: "src/pithy-screens.css",
      change: "removed",
      copy: "present",
    });
  });

  test("a new file the Worker already has in another shape is named as edited", () => {
    const files = new Map([["src/routes/pithy/choose-organization.tsx", "mine\n"]]);
    expect(classify({ files })).toContainEqual({
      worker: "board",
      path: "src/routes/pithy/choose-organization.tsx",
      change: "changed",
      copy: "edited",
    });
  });

  test("a patch-level move is reported too: 0.3.0 → 0.3.1 names sign-in.tsx", () => {
    const findings = classify({ from: [["0.3.0", V030]] });
    expect(findings).toContainEqual({
      worker: "board",
      path: "src/routes/pithy/sign-in.tsx",
      change: "changed",
      copy: "edited",
    });
  });
});

const packument = (name: string, versions: Record<string, Record<string, string>>, latest: string): Packument => ({
  name,
  "dist-tags": { latest },
  versions: Object.fromEntries(
    Object.entries(versions).map(([version, dependencies]) => [
      version,
      {
        version,
        dependencies,
        dist: { tarball: `https://registry.npmjs.org/${name}/-/x-${version}.tgz`, integrity: "sha512-AA==" },
      },
    ]),
  ),
});

const noPlan: PackagePlan = { moves: [], held: [], leftAlone: [] };
const move = (name: string, target: string) => ({
  name,
  manifest: "package.json",
  field: "dependencies" as const,
  from: "^0.0.0",
  to: `^${target}`,
  target,
});
const held = (name: string, latest: string) => ({
  name,
  manifest: "package.json",
  range: "^0.0.0",
  installed: null,
  latest,
  reason: "breaking" as const,
  command: "pithy upgrade --packages --latest",
});

describe("templateTargets", () => {
  const ui = packument(UI, { "0.2.0": {}, "0.2.3": {}, "0.3.0": {}, "0.3.1": {} }, "0.3.1");
  const cli = packument(
    CLI,
    { "0.9.4": { [UI]: "^0.2.0" }, "0.9.5": { [UI]: "^0.3.0" }, "0.10.0": { [UI]: "workspace:*" } },
    "0.9.5",
  );

  test("a declared ui-react that moves and is held gives two sections: applied and not", () => {
    const plan = { ...noPlan, moves: [move(UI, "0.2.3")], held: [held(UI, "0.3.1")] };
    expect(templateTargets({ plan, ui, cli })).toEqual([
      { version: "0.2.3", applied: true },
      { version: "0.3.1", applied: false },
    ]);
  });

  test("ui-react undeclared: a moving cli brings the newest ui-react its target version admits", () => {
    const plan = { ...noPlan, moves: [move(CLI, "0.9.5")] };
    expect(templateTargets({ plan, ui, cli })).toEqual([{ version: "0.3.1", applied: true }]);
    const heldCli = { ...noPlan, moves: [move(CLI, "0.9.4")], held: [held(CLI, "0.9.5")] };
    expect(templateTargets({ plan: heldCli, ui, cli })).toEqual([
      { version: "0.2.3", applied: true },
      { version: "0.3.1", applied: false },
    ]);
  });

  test("a cli whose ui-react range cannot be resolved gives a section with no target", () => {
    const plan = { ...noPlan, moves: [move(CLI, "0.10.0")] };
    expect(templateTargets({ plan, ui, cli })).toEqual([{ version: null, applied: true }]);
    expect(templateTargets({ plan: { ...noPlan, moves: [move(CLI, "0.9.5")] }, ui: null, cli })).toEqual([
      { version: null, applied: true },
    ]);
  });

  test("a patch move inside the range is a section too — the refusal code moved in 0.3.0 → 0.3.1", () => {
    const patch = { ...move(UI, "0.3.1"), from: "^0.3.0", to: "^0.3.1" };
    expect(templateTargets({ plan: { ...noPlan, moves: [patch] }, ui, cli })).toEqual([
      { version: "0.3.1", applied: true },
    ]);
  });

  test("nothing template-bearing moves: no section", () => {
    const plan = { ...noPlan, moves: [move("@pithy-sh/auth", "0.2.3")] };
    expect(templateTargets({ plan, ui, cli })).toEqual([]);
  });
});

describe("templateSections", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-templates-"));
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(
      join(dir, "apps", "board", "pithy.worker.jsonc"),
      JSON.stringify({ ui: { stub: "react", build: [] } }),
    );
    for (const [path, text] of BOARD) {
      await mkdir(dirname(join(dir, "apps", "board", path)), { recursive: true });
      await writeFile(join(dir, "apps", "board", path), text);
    }
    // A Worker with no front end: never read.
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "pithy.worker.jsonc"), JSON.stringify({ name: "api" }));
    await mkdir(join(dir, "apps", "api", "src", "routes", "pithy"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "src", "routes", "pithy", "sign-in.tsx"), "api's own\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Install a ui-react copy at `at` (a package directory) carrying `tree`. */
  async function installCopy(at: string, version: string, tree: TemplateTree) {
    await mkdir(at, { recursive: true });
    await writeFile(join(at, "package.json"), JSON.stringify({ name: UI, version }));
    for (const [path, text] of tree) {
      await mkdir(dirname(join(at, "templates", path)), { recursive: true });
      await writeFile(join(at, "templates", path), text);
    }
  }

  const tarball = templateTarball(Object.fromEntries(V031));
  const registry = (): RegistryFetch =>
    vi.fn(
      async (): Promise<RegistryResponse> => ({
        ok: true,
        status: 200,
        json: async () => null,
        arrayBuffer: async () => tarball.bytes.slice().buffer as ArrayBuffer,
      }),
    );
  const ui = (): Packument => ({
    name: UI,
    "dist-tags": { latest: "0.3.1" },
    versions: {
      "0.3.1": {
        version: "0.3.1",
        dist: {
          tarball: "https://registry.npmjs.org/@pithy-sh/ui-react/-/ui-react-0.3.1.tgz",
          integrity: tarball.integrity,
        },
      },
    },
  });
  const heldPlan: PackagePlan = { ...noPlan, held: [held(UI, "0.3.1")] };

  test("F is the root copy and the one the installed CLI resolves; T comes from the verified tarball", async () => {
    await installCopy(join(dir, "node_modules", "@pithy-sh", "ui-react"), "0.2.0", V020);
    // The CLI's own ui-react, found by realpath of the CLI and a walk up — bun's store layout.
    const store = join(dir, "node_modules", ".bun", "@pithy-sh+cli@0.9.5", "node_modules");
    await mkdir(join(store, "@pithy-sh", "cli"), { recursive: true });
    await writeFile(join(store, "@pithy-sh", "cli", "package.json"), JSON.stringify({ name: CLI, version: "0.9.5" }));
    await installCopy(join(store, "@pithy-sh", "ui-react"), "0.3.0", V030);
    await symlink(join(store, "@pithy-sh", "cli"), join(dir, "node_modules", "@pithy-sh", "cli"));

    const fetch = registry();
    const sections = await templateSections({
      projectDir: dir,
      plan: heldPlan,
      packuments: new Map([[UI, ui()]]),
      fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sections).toEqual([
      {
        state: "checked",
        package: UI,
        from: ["0.2.0", "0.3.0"],
        to: "0.3.1",
        applied: false,
        files: classify({}),
      },
    ]);
  });

  test("a local copy at exactly the target is read from disk, never fetched", async () => {
    await installCopy(join(dir, "node_modules", "@pithy-sh", "ui-react"), "0.2.0", V020);
    await installCopy(join(dir, "apps", "board", "node_modules", "@pithy-sh", "ui-react"), "0.3.1", V031);
    const fetch = registry();
    const sections = await templateSections({
      projectDir: dir,
      plan: heldPlan,
      packuments: new Map([[UI, ui()]]),
      fetch,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(sections[0]).toMatchObject({ state: "checked", from: ["0.2.0", "0.3.1"], to: "0.3.1" });
  });

  test("nothing installed to compare from: unchecked", async () => {
    const sections = await templateSections({
      projectDir: dir,
      plan: heldPlan,
      packuments: new Map([[UI, ui()]]),
      fetch: registry(),
    });
    expect(sections).toEqual([{ state: "unchecked", package: UI, from: [], to: "0.3.1", applied: false, files: [] }]);
  });

  test("a tarball whose integrity does not match is unavailable, and names nothing", async () => {
    await installCopy(join(dir, "node_modules", "@pithy-sh", "ui-react"), "0.2.0", V020);
    const tampered = ui();
    const version = tampered.versions["0.3.1"];
    if (version) version.dist.integrity = templateTarball({ "src/router.tsx": "x" }).integrity;
    const sections = await templateSections({
      projectDir: dir,
      plan: heldPlan,
      packuments: new Map([[UI, tampered]]),
      fetch: registry(),
    });
    expect(sections).toEqual([
      { state: "unavailable", package: UI, from: ["0.2.0"], to: "0.3.1", applied: false, files: [] },
    ]);
  });

  test("no template-bearing move: no section at all", async () => {
    expect(await templateSections({ projectDir: dir, plan: noPlan, packuments: new Map(), fetch: registry() })).toEqual(
      [],
    );
  });
});
