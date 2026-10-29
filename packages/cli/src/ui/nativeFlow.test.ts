// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { PACKAGE_VERSION } from "@pithy-sh/core/src/version.generated";
import { readGeneratedConfig } from "@pithy-sh/ui-react-native/src/generatedConfig";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Plan } from "../plan/plan";
import type { WorkerConfig } from "../project/config";
import { kitRange } from "../project/scaffold";
import { snapshotTree } from "../test-utils/treeSnapshot";
import { runUiAdd } from "./flow";
import { importedKitPackages } from "./kitRanges";
import { defaultAppFor, nativeApp, runNativeUiSync } from "./nativeFlow";
import type { UiRailPrompt } from "./rails";
import { reactNativeStub } from "./reactNative";
import { loadStubFiles } from "./templates";

/** The backend Worker's directory, and the name it deploys under — deliberately different. */
const WORKER = "api";
const DEPLOYED = "replay-api";

/** A capability with a client projection, the way a composed capability serves `virtual:pithy/<name>`. */
function projecting(name: string, projection: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return Object.assign(
    defineCapability({
      name,
      requiredBindings: [],
      client: () => ({ enabled: true, ...projection }) as never,
    }),
    extra,
  );
}

const BARE: WorkerConfig = { capabilities: [] };

/** A backend selling through Apple and Stripe, signing in, and answering on a production domain. */
const SELLING: WorkerConfig = {
  capabilities: [
    projecting("auth", { providers: ["google"] }),
    projecting("payments", { products: [] }, { paymentsConfig: { rails: { apple: true, stripe: true } } }),
  ],
  domains: { prod: { pattern: "api.acme.dev", zone: "acme.dev" } },
};

let projectDir: string;
let workerDir: string;
let appDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pithy-ui-native-"));
  workerDir = join(projectDir, "apps", WORKER);
  appDir = join(projectDir, "apps", "app");
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), `{\n  "name": "${DEPLOYED}"\n}\n`);
  await writeFile(join(workerDir, "pithy.worker.jsonc"), '{\n  "dev": {}\n}\n');
  await writeFile(
    join(workerDir, "package.json"),
    `${JSON.stringify({ name: DEPLOYED, dependencies: { "@pithy-sh/auth": "^0.11.0" } }, null, 2)}\n`,
  );
  await writeFile(join(projectDir, "tsconfig.json"), `${JSON.stringify({ files: [], references: [] }, null, 2)}\n`);
  await writeFile(
    join(projectDir, "pithy.config.ts"),
    'export default { name: "replay", environments: ["staging", "prod"] };\n',
  );
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/** The common half of every native `runUiAdd` call: the bare screens, so only the base templates are read. */
function options(config: WorkerConfig) {
  return {
    projectDir,
    workerDir,
    config,
    framework: "react-native",
    packageManager: "bun" as const,
    auth: false,
    payments: false,
    organization: false,
    consent: false,
    deployedName: DEPLOYED,
    // No copy beside the CLI and a registry that always answers, so a range is the same on every machine.
    kitRanges: { installedFrom: [], latest: async () => "0.9.0" },
  };
}

/** The generated config the app holds now. */
async function generated(dir = appDir) {
  const config = readGeneratedConfig(await readFile(join(dir, "src", "pithy-config.generated.ts"), "utf8"));
  if (config === null) return expect.unreachable("expected a generated config Pithy can read back");
  return config;
}

/** Every file the bare scaffold wrote, by app-relative path, read back. */
async function templateTexts(): Promise<Record<string, string>> {
  const files = await loadStubFiles(reactNativeStub, {
    worker: WORKER,
    app: "app",
    auth: false,
    payments: false,
    organization: false,
    consent: false,
    mcp: false,
    packageManager: "bun",
  });
  return Object.fromEntries(
    await Promise.all(Object.keys(files).map(async (path) => [path, await readFile(join(appDir, path), "utf8")])),
  );
}

/** The error a call throws, or a failed test. */
async function refusal(run: () => Promise<unknown>): Promise<PithyError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PithyError);
    return error as PithyError;
  }
  return expect.unreachable("expected a refusal");
}

describe("pithy ui add react-native", () => {
  test("writes an Expo app into its own apps/<name>, with no wrangler.jsonc, calling the worker", async () => {
    const report = await runUiAdd(options(BARE));

    expect(report).toMatchObject({
      worker: WORKER,
      framework: "react-native",
      app: "app",
      rails: { ios: "none", android: "none", web: "none" },
      auth: false,
      unstyled: [],
      runWorkerFirst: [],
      packageManager: "bun",
    });
    expect(report.created).toEqual(
      expect.arrayContaining(["app.config.ts", "src/routes/app/home.tsx", "src/pithy-config.generated.ts"]),
    );
    expect(report.created).not.toContain("src/routes/app/home.bare.tsx");
    await expect(readFile(join(appDir, "wrangler.jsonc"), "utf8")).rejects.toThrow();
    // The app's name lands where the templates leave a token for it.
    expect(await readFile(join(appDir, "app.config.ts"), "utf8")).toContain('name: "app"');
  });

  test("its pithy.worker.jsonc runs expo start on the pinned port and names the worker it calls", async () => {
    await runUiAdd(options(BARE));
    const manifest = parse(await readFile(join(appDir, "pithy.worker.jsonc"), "utf8")) as unknown as {
      dev: { command: string[]; readySignal: string };
      ui: { stub: string; build: string[]; worker: string };
    };
    expect(manifest.dev.command).toEqual(["bun", "x", "expo", "start", "--port", "{port}"]);
    expect(manifest.dev.readySignal).toBe("^Waiting on ");
    expect(manifest.ui).toEqual({
      stub: "react-native",
      build: ["expo", "export", "--platform", "web"],
      worker: WORKER,
    });
  });

  test("its package.json carries Expo Router's entry, the SDK's pins, and the backend's own kit ranges", async () => {
    const report = await runUiAdd(options(BARE));
    const pkg = JSON.parse(await readFile(join(appDir, "package.json"), "utf8")) as {
      name: string;
      main: string;
      private: boolean;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg).toMatchObject({ name: "app", main: "expo-router/entry", private: true });
    expect(pkg.dependencies).toMatchObject({
      expo: "~57.0.31",
      "react-native": "0.86.3",
      "react-native-web": "~0.21.0",
      "expo-router": "~57.0.29",
      // Copied from apps/api/package.json, so the app and the Worker run one release.
      "@pithy-sh/auth": "^0.11.0",
    });
    // Every other kit package a written template imports, and the backend declares none of them, so each takes the
    // next answer: here, the registry's latest.
    const imported = importedKitPackages(await templateTexts());
    for (const name of imported) {
      if (["@pithy-sh/auth", "@pithy-sh/core", "@pithy-sh/i18n", "@pithy-sh/ui-core"].includes(name)) continue;
      expect(pkg.dependencies[name], name).toBe("^0.9.0");
    }
    expect(imported).toContain("@pithy-sh/payments");
    // Nothing the written templates do not import.
    for (const name of Object.keys(pkg.dependencies).filter((dep) => dep.startsWith("@pithy-sh/"))) {
      expect(imported, name).toContain(name);
    }
    expect(report.unresolvedPackages).toEqual([]);
    const core = kitRange(PACKAGE_VERSION);
    if (core === null) expect(pkg.dependencies["@pithy-sh/core"]).toBeUndefined();
    else expect(pkg.dependencies["@pithy-sh/core"]).toBe(core);
    expect(pkg.scripts).toEqual({
      start: "expo start",
      android: "expo start --android",
      ios: "expo start --ios",
      web: "expo start --web",
    });
    expect(report.dependencies).toContain("expo");
    expect(report.scripts).toEqual(["start", "android", "ios", "web"]);
  });

  test("a kit package nothing has a range for is reported, not guessed", async () => {
    const report = await runUiAdd({ ...options(BARE), kitRanges: { installedFrom: [], latest: async () => null } });
    const expected = importedKitPackages(await templateTexts()).filter(
      (name) => !["@pithy-sh/auth", "@pithy-sh/core", "@pithy-sh/i18n", "@pithy-sh/ui-core"].includes(name),
    );
    expect(expected).toContain("@pithy-sh/payments");
    expect(report.unresolvedPackages).toEqual(expected);
    const pkg = JSON.parse(await readFile(join(appDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@pithy-sh/payments"]).toBeUndefined();
  });

  test("leaves the worker it calls and the root solution file alone", async () => {
    const worker = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");
    const solution = await readFile(join(projectDir, "tsconfig.json"), "utf8");
    await runUiAdd(options(BARE));
    expect(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")).toBe(worker);
    expect(await readFile(join(projectDir, "tsconfig.json"), "utf8")).toBe(solution);
  });

  test("the generated config falls back to the first dev port before pithy dev has pinned one", async () => {
    await runUiAdd(options(BARE));
    expect(await generated()).toMatchObject({
      origins: { dev: "http://localhost:8787", staging: null, prod: null },
      appScheme: "app",
      universalLinkOrigin: null,
      rails: { ios: "none", android: "none", web: "none" },
      google: { webClientId: null, iosClientId: null },
      auth: { enabled: false },
      i18n: { enabled: false },
      payments: { enabled: false },
      turnstile: { enabled: false },
    });
  });

  test("the generated config takes the origin pithy dev pinned for the worker", async () => {
    await writeFile(
      join(projectDir, ".dev.config.json"),
      JSON.stringify({
        version: 1,
        branch: "main",
        ports: { index: 0, base: 8787, size: 20 },
        workers: { [DEPLOYED]: { port: 8790, origin: "http://localhost:8790" } },
      }),
    );
    await runUiAdd(options(BARE));
    expect((await generated()).origins.dev).toBe("http://localhost:8790");
  });

  test("the generated config carries each capability's projection, the backend's domain and its rails", async () => {
    await runUiAdd(options(SELLING));
    const config = await generated();
    expect(config.auth).toEqual({ enabled: true, providers: ["google"] });
    expect(config.payments).toEqual({ enabled: true, products: [] });
    expect(config.universalLinkOrigin).toBe("https://api.acme.dev");
    expect(config.origins).toEqual({ dev: "http://localhost:8787", staging: null, prod: "https://api.acme.dev" });
    // Each platform's default, held to what the backend enables: no Google rail, so Android sells nothing.
    expect(config.rails).toEqual({ ios: "apple", android: "none", web: "stripe" });
    const text = await readFile(join(appDir, "src", "pithy-config.generated.ts"), "utf8");
    expect(text).toContain("from apps/api's composed config");
    expect(text).toContain("`ui sync --app` rewrites it");
  });

  test("an environment's origin comes from the worker's route when it declares no domain", async () => {
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      `${JSON.stringify({ name: DEPLOYED, env: { staging: { name: `${DEPLOYED}-staging`, routes: [{ pattern: "staging.acme.dev", custom_domain: true }] } } })}\n`,
    );
    await runUiAdd(options(SELLING));
    expect((await generated()).origins).toEqual({
      dev: "http://localhost:8787",
      staging: "https://staging.acme.dev",
      prod: "https://api.acme.dev",
    });
  });

  test("an environment the project does not deploy to has no origin at all", async () => {
    await writeFile(
      join(projectDir, "pithy.config.ts"),
      'export default { name: "replay", environments: ["prod"] };\n',
    );
    await runUiAdd(options(SELLING));
    expect((await generated()).origins).toEqual({ dev: "http://localhost:8787", prod: "https://api.acme.dev" });
  });

  test("names the trustedOrigins entries a worker composing auth lacks for the app's scheme and link", async () => {
    const authWith = (trustedOrigins: string[]): WorkerConfig => ({
      ...SELLING,
      capabilities: [projecting("auth", { providers: [] }, { authConfig: { trustedOrigins } })],
    });
    expect((await runUiAdd(options(authWith([])))).untrustedOrigins).toEqual(["app://", "https://api.acme.dev"]);
    await rm(appDir, { recursive: true, force: true });
    const trusted = await runUiAdd(options(authWith(["app://", "https://api.acme.dev"])));
    expect(trusted.untrustedOrigins).toEqual([]);
    await rm(appDir, { recursive: true, force: true });
    const bare = await runUiAdd(options(BARE));
    expect(bare.untrustedOrigins).toEqual([]);
    expect(bare.trustedOrigins).toEqual(["app://"]);
  });

  test("the account chooser needs the sign-in screens, so asking for it without them is refused", async () => {
    const organization = projecting("organization", {});
    const config: WorkerConfig = { capabilities: [projecting("auth", {}), organization] };
    const error = await refusal(() => runUiAdd({ ...options(config), auth: false, organization: true }));
    expect(error.payload.code).toBe("validation/invalid_input");
    expect(error.payload.message).toBe("The account chooser needs the sign-in screens, and this run leaves them out.");
    expect(error.payload.action).toBe("Pass --auth, or leave the account chooser out with --no-organization.");
  });

  test("without the sign-in screens, the account chooser is left out unless it was asked for", async () => {
    const config: WorkerConfig = { capabilities: [projecting("auth", {}), projecting("organization", {})] };
    const { organization: _, ...rest } = options(config);
    const report = await runUiAdd({ ...rest, auth: false });
    expect(report.organization).toBe(false);
  });

  test("a rail flag sets that platform, and a human is asked only the rest", async () => {
    const prompt = vi.fn<UiRailPrompt>(async ({ suggestion }) => suggestion);
    const report = await runUiAdd({ ...options(SELLING), rails: { web: "none" }, railPrompt: prompt });
    expect(report.rails).toEqual({ ios: "apple", android: "none", web: "none" });
    expect(prompt.mock.calls.map(([request]) => request.platform)).toEqual(["ios", "android"]);
  });

  test("a rail the backend does not enable is refused by name, and nothing is written", async () => {
    const before = await snapshotTree(projectDir);
    const error = await refusal(() => runUiAdd({ ...options(SELLING), rails: { android: "google" } }));
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(error.payload.message).toBe("The google rail isn't enabled in api's payments config.");
    expect(error.payload.action).toContain("rails.google");
    expect(await snapshotTree(projectDir)).toEqual(before);
  });

  test("a value no platform sells through is a validation error listing the valid ones", async () => {
    const error = await refusal(() => runUiAdd({ ...options(SELLING), rails: { ios: "google" } }));
    expect(error.payload.code).toBe("validation/invalid_input");
    expect(error.payload.action).toBe("Pass --ios-rail apple, stripe, lemonSqueezy, paddle or none.");
  });

  test("--app names the directory, and the app's name reaches its config", async () => {
    const report = await runUiAdd({ ...options(BARE), app: "phone" });
    expect(report.app).toBe("phone");
    expect((await generated(join(projectDir, "apps", "phone"))).appScheme).toBe("phone");
  });

  test("the default app is app, or mobile when the worker is itself called app", () => {
    expect(defaultAppFor("api")).toBe("app");
    expect(defaultAppFor("app")).toBe("mobile");
  });

  test("an app named for the worker it calls is refused", async () => {
    const error = await refusal(() => runUiAdd({ ...options(BARE), app: WORKER }));
    expect(error.payload.code).toBe("validation/invalid_input");
    expect(error.payload.action).toBe("Pass --app with another name, e.g. app.");
  });

  test("an app name that is not kebab-case is refused", async () => {
    const error = await refusal(() => runUiAdd({ ...options(BARE), app: "My App" }));
    expect(error.payload.code).toBe("validation/invalid_input");
    expect(error.payload.message).toBe('App name must be kebab-case (got "My App").');
  });

  test("an apps/<name> that is a worker is refused, and nothing is written", async () => {
    await mkdir(join(projectDir, "apps", "web"), { recursive: true });
    await writeFile(join(projectDir, "apps", "web", "wrangler.jsonc"), "{}\n");
    const before = await snapshotTree(projectDir);
    const error = await refusal(() => runUiAdd({ ...options(BARE), app: "web" }));
    expect(error.payload.code).toBe("core/conflict");
    expect(error.payload.message).toBe("apps/web is a worker, and an Expo app needs a directory of its own.");
    expect(await snapshotTree(projectDir)).toEqual(before);
  });

  test("an app holding another stub's front end is refused", async () => {
    await mkdir(join(projectDir, "apps", "web"), { recursive: true });
    await writeFile(
      join(projectDir, "apps", "web", "pithy.worker.jsonc"),
      '{ "ui": { "stub": "react", "build": ["vite", "build"] } }\n',
    );
    const error = await refusal(() => runUiAdd({ ...options(BARE), app: "web" }));
    expect(error.payload.code).toBe("core/conflict");
    expect(error.payload.message).toBe("apps/web already has a react front end.");
  });

  test("adding the same app twice is refused, pointing at ui sync", async () => {
    await runUiAdd(options(BARE));
    const error = await refusal(() => runUiAdd(options(BARE)));
    expect(error.payload.code).toBe("core/conflict");
    expect(error.payload.action).toContain("pithy ui sync --app app --worker api");
  });

  test("a backfill writes the rails it resolves and the worker's projections, keeping the adopter's choices", async () => {
    // What `pithy init --react-native` leaves: no screens, every rail none, nothing composed.
    await runUiAdd(options(BARE));
    const path = join(appDir, "src", "pithy-config.generated.ts");
    await writeFile(path, (await readFile(path, "utf8")).replace('appScheme: "app"', 'appScheme: "acme"'));

    const report = await runUiAdd({
      ...options(SELLING),
      auth: true,
      payments: true,
      rails: { ios: "apple", web: "stripe" },
    });

    const config = await generated();
    expect(config.rails).toEqual({ ios: "apple", android: "none", web: "stripe" });
    expect(report.rails).toEqual(config.rails);
    expect(config.auth).toMatchObject({ enabled: true });
    expect(config.payments).toMatchObject({ enabled: true });
    expect(config.appScheme).toBe("acme");
    expect(report.trustedOrigins).toEqual([
      "acme://",
      ...(config.universalLinkOrigin ? [config.universalLinkOrigin] : []),
    ]);
    expect(report.created).toEqual(expect.arrayContaining(["src/routes/pithy/sign-in.tsx"]));
  });

  test("a backfill keeps the rails already written, and asks no one about them", async () => {
    const first = await runUiAdd({ ...options(SELLING), rails: { ios: "apple", web: "none" } });
    expect(first.backfill).toBe(false);
    const prompt = vi.fn<UiRailPrompt>(async ({ suggestion }) => suggestion);
    const report = await runUiAdd({ ...options(SELLING), auth: true, railPrompt: prompt });
    expect(prompt).not.toHaveBeenCalled();
    expect(report.backfill).toBe(true);
    expect(report.rails).toEqual({ ios: "apple", android: "none", web: "none" });
    expect((await generated()).rails).toEqual(report.rails);
  });

  test("a backfill over a config that is not the one Pithy writes is refused, and nothing is written", async () => {
    await runUiAdd(options(BARE));
    await writeFile(join(appDir, "src", "pithy-config.generated.ts"), "export default {};\n");
    const before = await snapshotTree(projectDir);
    const error = await refusal(() => runUiAdd({ ...options(SELLING), auth: true }));
    expect(error.payload.code).toBe("core/conflict");
    expect(error.payload.message).toBe("apps/app/src/pithy-config.generated.ts is not the config Pithy writes there.");
    expect(await snapshotTree(projectDir)).toEqual(before);
  });

  test("a colliding file on a first scaffold is refused, naming the command to retry with", async () => {
    await mkdir(join(appDir, "src"), { recursive: true });
    await writeFile(join(appDir, "src", "theme.ts"), "export const theme = {};\n");
    const error = await refusal(() => runUiAdd(options(BARE)));
    expect(error.payload.code).toBe("core/conflict");
    expect(error.payload.message).toContain("src/theme.ts");
    expect(error.payload.action).toContain("pithy ui add react-native --app app --worker api");
  });

  test("a run that fails partway leaves the project as it found it", async () => {
    // A package.json that does not parse fails the wiring after the templates are written.
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "package.json"), "{ not json\n");
    const before = await snapshotTree(projectDir);
    await refusal(() => runUiAdd(options(BARE)));
    expect(await snapshotTree(projectDir)).toEqual(before);
  });

  test("--dry-run writes nothing, and plans every file the real run creates", async () => {
    const before = await snapshotTree(projectDir);
    const report = await runUiAdd({ ...options(BARE), dryRun: true });
    expect(await snapshotTree(projectDir)).toEqual(before);
    const plan = Plan.parse(report.plan);
    const planned = plan.files.map((file) => file.path);
    expect(planned).toEqual(
      expect.arrayContaining([
        "apps/app/app.config.ts",
        "apps/app/package.json",
        "apps/app/pithy.worker.jsonc",
        "apps/app/src/pithy-config.generated.ts",
      ]),
    );
  });
});

describe("pithy ui sync --app", () => {
  /** Sync the app against `config`. */
  function sync(config: WorkerConfig, extra: { check?: boolean; rails?: Record<string, string> } = {}) {
    return runNativeUiSync({ projectDir, appDir, workerDir, config, deployedName: DEPLOYED, ...extra });
  }

  test("finds the app and the worker its manifest names", async () => {
    await runUiAdd(options(BARE));
    expect(await nativeApp(projectDir, "app")).toEqual({ appDir, worker: WORKER });
  });

  test("an app with no React Native front end is not found, with the command that scaffolds one", async () => {
    const error = await refusal(() => nativeApp(projectDir, "app"));
    expect(error.payload.code).toBe("core/not_found");
    expect(error.payload.action).toContain("pithy ui add react-native --app app");
  });

  test("rewrites the projections from the worker and keeps the adopter's choices", async () => {
    await runUiAdd(options(SELLING));
    const path = join(appDir, "src", "pithy-config.generated.ts");
    const edited = (await readFile(path, "utf8"))
      .replace('appScheme: "app"', 'appScheme: "acme"')
      .replace('universalLinkOrigin: "https://api.acme.dev"', 'universalLinkOrigin: "https://links.acme.dev"');
    await writeFile(path, edited);

    const next: WorkerConfig = {
      ...SELLING,
      capabilities: [...SELLING.capabilities, projecting("turnstile", { sitekey: "x" })],
    };
    const report = await sync(next);

    expect(report).toMatchObject({
      worker: WORKER,
      app: "app",
      changed: true,
      rails: { ios: "apple", android: "none", web: "stripe" },
    });
    const config = await generated();
    expect(config.turnstile).toEqual({ enabled: true, sitekey: "x" });
    expect(config.appScheme).toBe("acme");
    expect(config.universalLinkOrigin).toBe("https://links.acme.dev");
  });

  test("--worker points the app at another worker, and its manifest remembers it", async () => {
    await runUiAdd(options(BARE));
    const otherDir = join(projectDir, "apps", "edge");
    await mkdir(otherDir, { recursive: true });
    await runNativeUiSync({ projectDir, appDir, workerDir: otherDir, config: BARE, deployedName: "replay-edge" });
    expect(await nativeApp(projectDir, "app")).toEqual({ appDir, worker: "edge" });
  });

  test("--check against another worker leaves the manifest alone", async () => {
    await runUiAdd(options(BARE));
    const otherDir = join(projectDir, "apps", "edge");
    await mkdir(otherDir, { recursive: true });
    await runNativeUiSync({ projectDir, appDir, workerDir: otherDir, config: BARE, check: true });
    expect(await nativeApp(projectDir, "app")).toEqual({ appDir, worker: WORKER });
  });

  test("keeps an origin the adopter set for an environment the worker names none for", async () => {
    await runUiAdd(options(BARE));
    const path = join(appDir, "src", "pithy-config.generated.ts");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("staging: null", 'staging: "https://api-staging.workers.example"'),
    );
    expect((await sync(BARE)).changed).toBe(false);
    expect((await generated()).origins.staging).toBe("https://api-staging.workers.example");
  });

  test("a second sync changes nothing", async () => {
    await runUiAdd(options(SELLING));
    expect((await sync(SELLING)).changed).toBe(false);
  });

  test("--check reports the drift and writes nothing", async () => {
    await runUiAdd(options(BARE));
    const path = join(appDir, "src", "pithy-config.generated.ts");
    const before = await readFile(path, "utf8");
    const report = await sync(SELLING, { check: true });
    expect(report.changed).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("a rail flag changes that platform's rail, and the others keep theirs", async () => {
    await runUiAdd(options(SELLING));
    const report = await sync(SELLING, { rails: { web: "none" } });
    expect(report.rails).toEqual({ ios: "apple", android: "none", web: "none" });
    expect((await generated()).rails).toEqual({ ios: "apple", android: "none", web: "none" });
  });

  test("a kept rail the worker has stopped enabling is refused by name", async () => {
    await runUiAdd(options(SELLING));
    const without: WorkerConfig = {
      ...SELLING,
      capabilities: [projecting("payments", { products: [] }, { paymentsConfig: { rails: { stripe: true } } })],
    };
    const error = await refusal(() => sync(without));
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(error.payload.message).toBe("The apple rail isn't enabled in api's payments config.");
  });

  test("a file that is not the config Pithy writes is refused rather than overwritten", async () => {
    await runUiAdd(options(BARE));
    const path = join(appDir, "src", "pithy-config.generated.ts");
    await writeFile(path, "export default {};\n");
    const error = await refusal(() => sync(BARE));
    expect(error.payload.code).toBe("core/conflict");
    expect(await readFile(path, "utf8")).toBe("export default {};\n");
  });

  test("a deleted config is written again from the defaults", async () => {
    await runUiAdd(options(SELLING));
    await rm(join(appDir, "src", "pithy-config.generated.ts"));
    const report = await sync(SELLING);
    expect(report.changed).toBe(true);
    expect((await generated()).rails).toEqual({ ios: "apple", android: "none", web: "stripe" });
  });
});
