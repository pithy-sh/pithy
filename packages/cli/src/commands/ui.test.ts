// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkerDir } from "@pithy-sh/core/src/cli/command";
import type { CommandDef } from "citty";
import { afterEach, describe, expect, test, vi } from "vitest";
import { main } from "../main";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import type { UiAddReport, UiSyncReport } from "../ui/flow";
import ui from "./ui";

/** What the stubbed `runUiSync` answers. Rewritten per test; the command is the subject, not the flow. */
// `vi.hoisted` runs before any import is bound, so the Worker is cast to its brand here rather than built.
const stub = vi.hoisted(() => ({
  report: {
    worker: "board" as WorkerDir,
    before: [],
    after: [],
    changed: false,
    uncovered: [],
    unstyled: [],
    notFoundHandling: "single-page-application",
  } as UiSyncReport,
  add: {
    worker: "board" as WorkerDir,
    framework: "react",
    auth: true,
    payments: false,
    organization: false,
    consent: false,
    created: ["src/main.tsx"],
    skipped: ["src/styles.css"],
    unstyled: [],
    runWorkerFirst: ["/auth/*"],
    packageManager: "bun",
    dependencies: ["react"],
    devDependencies: ["vite"],
    scripts: ["dev"],
  } as UiAddReport,
}));

vi.mock("../ui/flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/flow")>()),
  runUiSync: async () => stub.report,
  runUiAdd: async () => stub.add,
}));

/** What the stubbed native sync answers, and what it was called with. */
const native = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  report: {
    worker: "board" as WorkerDir,
    app: "app",
    rails: { ios: "apple", android: "google", web: "stripe" },
    before: [],
    after: [],
    changed: true,
    uncovered: [],
    unstyled: [],
    notFoundHandling: undefined,
  } as UiSyncReport,
}));

vi.mock("../ui/nativeFlow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/nativeFlow")>()),
  nativeApp: async (projectDir: string, app: string) => ({ appDir: `${projectDir}/apps/${app}`, worker: "board" }),
  runNativeUiSync: async (options: Record<string, unknown>) => {
    native.calls.push(options);
    return native.report;
  },
}));

/** What the stubbed worker composes. */
const worker = vi.hoisted(() => ({ capabilities: [] as { name: string }[] }));

vi.mock("./add", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./add")>()),
  targetWorker: async () => ({
    dir: "/project/apps/board",
    name: "replay-board",
    config: { capabilities: worker.capabilities },
  }),
}));

/** The args are static object literals on these commands — resolve their type for the assertions. */
type ArgSpec = { type: string; default?: unknown; required?: boolean };

function subcommand(name: string): CommandDef {
  const found = (ui.subCommands as Record<string, CommandDef>)[name];
  if (!found) throw new Error(`expected subcommand "${name}"`);
  return found;
}

function args(name: string): Record<string, ArgSpec> {
  return (subcommand(name).args ?? {}) as Record<string, ArgSpec>;
}

describe("ui command", () => {
  test("is a noun group: add, sync, list", () => {
    expect(ui.meta).toMatchObject({ name: "ui" });
    expect(Object.keys(ui.subCommands ?? {})).toEqual(["add", "sync", "list"]);
  });

  test("add takes a framework positional, --worker, one flag per screen set, --dry-run and --json", () => {
    expect(Object.keys(args("add"))).toEqual([
      "framework",
      "worker",
      "app",
      "ios-rail",
      "android-rail",
      "web-rail",
      "auth",
      "payments",
      "organization",
      "consent",
      "dry-run",
      "json",
    ]);
    expect(args("add").framework).toMatchObject({ type: "positional", required: true });
    expect(args("add").worker).toMatchObject({ type: "string" });
    expect(args("add").json).toMatchObject({ type: "boolean", default: false });
  });

  test("no screen-set flag carries a default, so `neither flag given` stays distinguishable", () => {
    // A default of false would make --no-auth unobservable and kill the "default to yes when the
    // capability is composed" rule; a default of true would scaffold broken imports on a worker without it.
    for (const screens of ["auth", "payments", "organization"]) {
      expect(args("add")[screens], screens).toMatchObject({ type: "boolean" });
      expect(args("add")[screens]?.default, screens).toBeUndefined();
    }
  });

  test("there are no provider flags — the sign-in screen reads pithy.config.ts instead", () => {
    for (const provider of ["google", "apple", "facebook", "github", "microsoft"]) {
      expect(Object.keys(args("add"))).not.toContain(provider);
    }
    expect(subcommand("add").meta).toBeDefined();
  });

  test("every subcommand is agent-drivable", () => {
    for (const name of ["add", "sync", "list"]) {
      expect(Object.keys(args(name)), name).toContain("json");
      expect(args(name).json, name).toMatchObject({ type: "boolean", default: false });
    }
  });

  test("sync takes the same --worker resolution as add, --app and the rails for an app, plus the --check CI gate", () => {
    expect(Object.keys(args("sync"))).toEqual([
      "worker",
      "app",
      "ios-rail",
      "android-rail",
      "web-rail",
      "check",
      "json",
    ]);
    // Defaulted, and defaulted to writing: a stale allowlist answers with the SPA shell and a 200, so
    // the repair is the ordinary run and the check is the one you ask for.
    expect(args("sync").check).toMatchObject({ type: "boolean", default: false });
  });

  test("no rail flag carries a default, so an unflagged platform is asked or keeps its rail", () => {
    for (const command of ["add", "sync"]) {
      for (const flag of ["ios-rail", "android-rail", "web-rail"]) {
        expect(args(command)[flag], `${command} ${flag}`).toMatchObject({ type: "string" });
        expect(args(command)[flag]?.default, `${command} ${flag}`).toBeUndefined();
      }
    }
  });

  test("pithy registers it, lazily", async () => {
    const entry = (main.subCommands as Record<string, () => Promise<CommandDef>>).ui;
    expect(typeof entry).toBe("function");
    expect(await entry?.()).toBe(ui);
  });
});

/**
 * **The report can fail a run (#401).**
 *
 * It could not before: the unstyled check ran once at `pithy ui add`, printed to stdout, and left the
 * exit status alone. A warning nothing acts on and nothing repeats is not a gate, and it had been read
 * as one. Stating the invariant is not proving it, so this drives the command and reads the exit.
 */
describe("ui sync --check turns a finding into an exit code", () => {
  /** Drive `pithy ui sync` with the stubbed flow: the exit status it left behind, and what it printed. */
  async function runSync(check: boolean): Promise<{ exit: number | undefined; output: string }> {
    process.exitCode = undefined;
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await (subcommand("sync").run as (context: { args: Record<string, unknown> }) => Promise<void>)({
        args: { check, json: false },
      });
    } finally {
      spy.mockRestore();
    }
    return { exit: process.exitCode, output: written.join("") };
  }

  afterEach(() => {
    process.exitCode = undefined;
    stub.report = { ...stub.report, uncovered: [], unstyled: [] };
  });

  test("a screen with no rules exits 1, and the classes are named", async () => {
    stub.report = { ...stub.report, unstyled: ["divider", "stack"] };
    const { exit, output } = await runSync(true);
    expect(exit).toBe(1);
    expect(output).toContain("divider");
    expect(output).toContain("stack");
    // Not "there are 2 problems". The list is the fix.
    expect(output).toContain("restore src/pithy-screens.css");
  });

  test("and a worker whose screens are all styled exits clean", async () => {
    // The calibration. Without it the reading above passes on a command that exits 1 unconditionally,
    // which is the same output as a gate and none of the meaning.
    stub.report = { ...stub.report, unstyled: [] };
    expect((await runSync(true)).exit).toBeUndefined();
  });

  test("the writing run says so and does not fail — it is the repair, not the gate", async () => {
    // `pithy ui sync` with no flag is somebody fixing an allowlist. Exiting 1 there would break every
    // script that runs the fix, over a stylesheet the command never touched.
    stub.report = { ...stub.report, unstyled: ["divider", "stack"] };
    const { exit, output } = await runSync(false);
    expect(exit).toBeUndefined();
    expect(output).toContain("divider");
  });
});

/** All three, through the real commands, held to the schema `pithy schema ui` publishes (#697). */
describe("pithy ui --json conforms to its published payloads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("add, sync and list", async () => {
    await expectConforms("ui add", await runCaptured("ui add", ["react", "--json"]));
    const before = stub.add;
    stub.add = {
      ...before,
      framework: "react-native",
      app: "app",
      rails: { ios: "apple", android: "google", web: "none" },
      trustedOrigins: ["app://"],
      untrustedOrigins: ["app://"],
      unresolvedPackages: [],
    };
    try {
      const written = await runCaptured("ui add", ["react-native", "--json"]);
      await expectConforms("ui add", written);
      expect(JSON.parse(written.join(""))).toMatchObject({
        app: "app",
        rails: { web: "none" },
        trustedOrigins: ["app://"],
        untrustedOrigins: ["app://"],
      });
    } finally {
      stub.add = before;
    }
    await expectConforms("ui sync", await runCaptured("ui sync", ["--json"]));
    await expectConforms("ui list", await runCaptured("ui list", ["--json"]));
  });

  test("a backfill's refreshed declarations conform, and the human run names them", async () => {
    const before = stub.add;
    stub.add = { ...before, skipped: ["src/pithy-config.tsx"], refreshed: ["client-env.d.ts"] };
    try {
      const json = await runCaptured("ui add", ["react", "--json"]);
      await expectConforms("ui add", json);
      expect(JSON.parse(json.join("")).refreshed).toEqual(["client-env.d.ts"]);
      const human = (await runCaptured("ui add", ["react"])).join("");
      expect(human).toContain("Refreshed to the kit's current declarations: client-env.d.ts.");
    } finally {
      stub.add = before;
    }
  });

  /** The install it left required, as `next`, and no key when it wrote no dependency (#697). */
  test("add names the install when it wrote dependencies, and carries no next when it wrote none", async () => {
    const wrote = JSON.parse((await runCaptured("ui add", ["react", "--json"])).join(""));
    expect(wrote.next).toEqual([
      { command: "bun install", why: "ui add wrote 2 packages into package.json, and the build needs them installed." },
    ]);
    const before = stub.add;
    stub.add = { ...before, dependencies: [], devDependencies: [] };
    try {
      const none = await runCaptured("ui add", ["react", "--json"]);
      expect(Object.hasOwn(JSON.parse(none.join("")), "next")).toBe(false);
      await expectConforms("ui add", none);
    } finally {
      stub.add = before;
    }
  });
});

/** `pithy ui sync --app`: a React Native app's generated config, rewritten from the Worker it calls. */
describe("ui sync --app", () => {
  /** Drive `pithy ui sync` with `args`: the exit status it left behind, and what it printed. */
  async function runSync(extra: Record<string, unknown>): Promise<{ exit: number | undefined; output: string }> {
    process.exitCode = undefined;
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await (subcommand("sync").run as (context: { args: Record<string, unknown> }) => Promise<void>)({
        args: { check: false, json: false, ...extra },
      });
    } finally {
      spy.mockRestore();
    }
    return { exit: process.exitCode, output: written.join("") };
  }

  afterEach(() => {
    process.exitCode = undefined;
    native.calls.length = 0;
    native.report = { ...native.report, changed: true };
  });

  test("rewrites the app's config from its worker, and hands the rail flags over", async () => {
    const { exit, output } = await runSync({ app: "app", "ios-rail": "stripe" });
    expect(exit).toBeUndefined();
    expect(output).toContain("Rewrote apps/app/src/pithy-config.generated.ts from board's config.");
    expect(native.calls).toHaveLength(1);
    expect(native.calls[0]).toMatchObject({
      appDir: `${process.cwd()}/apps/app`,
      rails: { ios: "stripe" },
      check: false,
    });
  });

  test("--check on a config behind its worker exits 1 and names the command that fixes it", async () => {
    const { exit, output } = await runSync({ app: "app", check: true });
    expect(exit).toBe(1);
    expect(output).toContain("is behind board's config.");
    expect(output).toContain("pithy ui sync --app app --worker board");
  });

  test("--check on a config in sync exits clean", async () => {
    native.report = { ...native.report, changed: false };
    const { exit, output } = await runSync({ app: "app", check: true });
    expect(exit).toBeUndefined();
    expect(output).toContain("already in sync with board");
  });

  test("a rail flag with no --app is refused, before anything is read", async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    try {
      await (subcommand("sync").run as (context: { args: Record<string, unknown> }) => Promise<void>)({
        args: { check: false, json: false, "web-rail": "stripe" },
      }).catch(() => undefined);
    } finally {
      spy.mockRestore();
      exit.mockRestore();
    }
    expect(written.join("")).toContain("no --app names one");
    expect(native.calls).toHaveLength(0);
  });

  test("--json conforms to the published payload, with the app and its rails", async () => {
    const written = await runCaptured("ui sync", ["--app", "app", "--json"]);
    await expectConforms("ui sync", written);
    expect(JSON.parse(written.join(""))).toMatchObject({ app: "app", rails: { ios: "apple" } });
  });
});

/** What `pithy ui add react-native` tells a person: where the app went, its rails, and what to set next. */
describe("ui add react-native", () => {
  /** The text `ui add react-native` prints for a report like `report`. */
  async function added(report: Partial<UiAddReport>, composed: string[] = []): Promise<string> {
    const before = stub.add;
    worker.capabilities = composed.map((name) => ({ name }));
    stub.add = {
      ...before,
      worker: "board" as WorkerDir,
      framework: "react-native",
      app: "app",
      skipped: [],
      ...report,
    };
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await (subcommand("add").run as (context: { args: Record<string, unknown> }) => Promise<void>)({
        args: { framework: "react-native", json: false, "dry-run": false },
      });
    } finally {
      spy.mockRestore();
      stub.add = before;
      worker.capabilities = [];
    }
    return written.join("");
  }

  const rails = { ios: "apple", android: "none", web: "stripe" } as const;

  test("names each trustedOrigins entry the worker's auth lacks, and the file it goes in", async () => {
    const output = await added({
      rails,
      trustedOrigins: ["app://", "https://links.acme.dev"],
      untrustedOrigins: ["app://", "https://links.acme.dev"],
    });
    expect(output).toContain(
      'Add "app://" and "https://links.acme.dev" to auth\'s trustedOrigins in apps/board/pithy.config.ts.',
    );
  });

  test("says nothing about trustedOrigins when auth already trusts the app", async () => {
    const output = await added({ rails, auth: true, trustedOrigins: ["app://"], untrustedOrigins: [] }, ["auth"]);
    expect(output).not.toContain("trustedOrigins");
  });

  test("without auth composed, names the entry to add once it is", async () => {
    const output = await added({ rails, auth: false, trustedOrigins: ["app://"], untrustedOrigins: [] });
    expect(output).toContain('When board composes auth, its trustedOrigins needs "app://".');
  });

  test("auth composed and trusting the app, with its screens left out, says nothing about trustedOrigins", async () => {
    // `--no-auth` leaves the screens out. The Worker still composes auth, and already trusts the app.
    const output = await added({ rails, auth: false, trustedOrigins: ["app://"], untrustedOrigins: [] }, ["auth"]);
    expect(output).not.toContain("trustedOrigins");
  });

  test("auth not composed, with its screens reported, still names the entry to add once it is", async () => {
    const output = await added({ rails, auth: true, trustedOrigins: ["app://"], untrustedOrigins: [] });
    expect(output).toContain('When board composes auth, its trustedOrigins needs "app://".');
  });

  test("on a backfill, says the generated config was rewritten from the Worker, choices kept", async () => {
    const output = await added({ rails, backfill: true });
    expect(output).toContain(
      "apps/app/src/pithy-config.generated.ts was rewritten from board's config. Its rails, appScheme, universalLinkOrigin and Google client ids were kept.",
    );
    expect(output).not.toContain("holds board's config");
  });

  test("on a first scaffold, says what the generated config holds and what to set", async () => {
    const output = await added({ rails, backfill: false });
    expect(output).toContain("apps/app/src/pithy-config.generated.ts holds board's config.");
    expect(output).not.toContain("was rewritten");
  });

  test("names a kit package it found no range for", async () => {
    const output = await added({ rails, unresolvedPackages: ["@pithy-sh/consent"] });
    expect(output).toContain("No range found for @pithy-sh/consent. Add one to apps/app/package.json.");
  });

  test("names the app, the worker it calls and each platform's rail", async () => {
    const before = stub.add;
    stub.add = {
      ...before,
      worker: "board" as WorkerDir,
      framework: "react-native",
      app: "app",
      rails: { ios: "apple", android: "none", web: "stripe" },
      skipped: [],
    };
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await (subcommand("add").run as (context: { args: Record<string, unknown> }) => Promise<void>)({
        args: { framework: "react-native", json: false, "dry-run": false },
      });
    } finally {
      spy.mockRestore();
      stub.add = before;
    }
    const output = written.join("");
    expect(output).toContain("Scaffolded a react-native app into apps/app. It calls board.");
    expect(output).toContain("Rails: iOS apple, Android none, web stripe.");
    expect(output).toContain("Set appScheme and universalLinkOrigin there before a store build.");
    expect(output).toContain("pithy ui sync --app app --worker board");
    expect(output).not.toContain("Worker-first");
  });
});
