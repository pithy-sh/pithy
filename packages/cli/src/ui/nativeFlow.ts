// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { commandName, pithyCommand } from "@pithy-sh/core/src/cli/command";
import { ConflictError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import {
  GENERATED_CONFIG_PATH,
  type GeneratedConfig,
  keepAdopterChoices,
  type PlatformRails,
  readGeneratedConfig,
  renderGeneratedConfig,
} from "@pithy-sh/ui-react-native/src/generatedConfig";
import { emptyPlan, type Plan } from "../plan/plan";
import { inShadow } from "../plan/shadow";
import { writeFileAtomic } from "../project/atomic";
import { allCapabilities, type WorkerConfig } from "../project/config";
import { detectPackageManager } from "../project/packageManager";
import { readOptionalFile } from "../project/readOptionalFile";
import { withRollback } from "../project/rollback";
import { pathExists, WORKER_NAME } from "../project/scaffold";
import { workerDirName } from "../project/workerIdentity";
import type { UiAddOptions, UiAddReport, UiSyncReport } from "./flow";
import { importedKitPackages, kitRangesFor } from "./kitRanges";
import { buildGeneratedConfig, generatedConfigFile, originsFor } from "./nativeConfig";
import { backendRails, type RailPlatform, resolveRails, type UiRailPrompt } from "./rails";
import { scaffoldFiles } from "./scaffold";
import { resolveScreenSets } from "./screens";
import type { UiStub } from "./stubs";
import { loadStubFiles } from "./templates";
import { rewireBackend, wireManifest, wirePackage } from "./wire";
import { readWorkerUi } from "./workerUi";

/**
 * `pithy ui add` and `pithy ui sync` for a stub whose front end lives in an `apps/<name>/` of its own.
 *
 * The app is not a Worker: no `wrangler.jsonc`, no `pithy.config.ts`, no asset allowlist. Its
 * `pithy.worker.jsonc` names the stub, the dev command `pithy dev` runs, and the backend Worker it calls, so a
 * sync can find that Worker again. Its config arrives as `src/pithy-config.generated.ts`, written from the
 * backend's composed config, because Metro cannot resolve `virtual:pithy/*`.
 */

/** The app's directory when `--app` names none: `app`, or `mobile` when the Worker it calls is `app`. */
export function defaultAppFor(worker: string): string {
  return worker === "app" ? "mobile" : "app";
}

/** The rail flags and the prompt, as `pithy ui add` and `pithy init` hand them over. */
export interface RailChoices {
  /** `--ios-rail`, `--android-rail` and `--web-rail`, raw. Undefined means "decide". */
  rails?: Partial<Record<RailPlatform, string>>;
  /** Asks a human which rail each platform sells through. Supplied only when one is attached. */
  railPrompt?: UiRailPrompt;
}

/** Refuse an app name that is not kebab-case, or that is the Worker the app calls. */
export function requireAppName(app: string, worker: string): void {
  if (!WORKER_NAME.test(app)) {
    throw new ValidationError({
      message: `App name must be kebab-case (got "${app}").`,
      action: "Pass --app with lowercase words joined by hyphens, e.g. app or mobile.",
    });
  }
  if (app === worker) {
    throw new ValidationError({
      message: `The app needs a directory of its own, and apps/${app} is the worker it calls.`,
      action: `Pass --app with another name, e.g. ${defaultAppFor(worker)}.`,
    });
  }
}

/** `apps/<app>` for a valid app name, or the refusal naming `--app`. */
function appDirFor(projectDir: string, app: string, worker: string): string {
  requireAppName(app, worker);
  return join(projectDir, "apps", app);
}

/** Refuse an `apps/<app>` that is a Worker, or that holds another stub's front end. */
async function guardAppDir(appDir: string, app: string, stub: UiStub): Promise<{ existing: boolean }> {
  for (const file of ["wrangler.jsonc", "pithy.config.ts"]) {
    if (await pathExists(join(appDir, file))) {
      throw new ConflictError({
        message: `apps/${app} is a worker, and an Expo app needs a directory of its own.`,
        action: "Pass --app with a name nothing under apps/ uses.",
      });
    }
  }
  const current = await readWorkerUi(appDir);
  if (current !== null && current.stub !== stub.id) {
    throw new ConflictError({
      message: `apps/${app} already has a ${current.stub} front end.`,
      action: "Pass --app with a name nothing under apps/ uses.",
    });
  }
  return { existing: current !== null };
}

/**
 * The config an app already holds, read back, and its text: both `null` when there is none. A file that is not the
 * config Pithy writes is refused rather than overwritten.
 */
async function readAppConfig(
  appDir: string,
  app: string,
): Promise<{ text: string | null; previous: GeneratedConfig | null }> {
  const text = await readOptionalFile(generatedConfigFile(appDir));
  const previous = text === null ? null : readGeneratedConfig(text);
  if (text !== null && previous === null) {
    throw new ConflictError({
      message: `apps/${app}/${GENERATED_CONFIG_PATH} is not the config Pithy writes there.`,
      action: "Restore its shape, or delete it to start from the defaults, then run the command again.",
    });
  }
  return { text, previous };
}

/**
 * The entries auth's `trustedOrigins` needs for the app and does not have: the app's scheme, which a sign-in returns
 * to, and its universal-link origin when it has one. Empty when the Worker composes no auth.
 */
export function untrustedOrigins(config: WorkerConfig, generated: GeneratedConfig): string[] {
  const auth = allCapabilities(config).find((capability) => capability.name === "auth");
  if (auth === undefined) return [];
  const listed = (auth as { authConfig?: { trustedOrigins?: unknown } }).authConfig?.trustedOrigins;
  const trusted = Array.isArray(listed) ? listed : [];
  return trustedOriginsFor(generated).filter((entry) => !trusted.includes(entry));
}

/** The `trustedOrigins` entries an app needs: its scheme, as `<scheme>://`, and its universal-link origin when set. */
export function trustedOriginsFor(generated: GeneratedConfig): string[] {
  return [`${generated.appScheme}://`, ...(generated.universalLinkOrigin ? [generated.universalLinkOrigin] : [])];
}

/** The `package.json` an app starts from: its name, and Expo Router's entry. */
function starterPackage(app: string): string {
  return `${JSON.stringify({ name: app, version: "0.1.0", private: true, main: "expo-router/entry" }, null, 2)}\n`;
}

/** Every file a native add may create or edit, absolute — what a failure has to put back. */
function touchedPaths(appDir: string, planned: Record<string, string>): string[] {
  return [
    ...Object.keys(planned).map((rel) => join(appDir, rel)),
    join(appDir, "pithy.worker.jsonc"),
    join(appDir, "package.json"),
  ];
}

/**
 * Scaffold an Expo app into `apps/<app>/` and point it at the backend Worker: the templates, the generated
 * config, a `package.json` with the SDK's pins, and the `pithy.worker.jsonc` that lets `pithy dev` run it.
 *
 * Every decision — screens, rails, the config's values — is made before anything is written, and the writes
 * run under {@link withRollback}, so a failed run leaves the project as it found it.
 */
export async function runNativeUiAdd(options: UiAddOptions, stub: UiStub): Promise<UiAddReport> {
  const packageManager = options.packageManager ?? (await detectPackageManager(options.projectDir));
  const worker = workerDirName({ dir: options.workerDir });
  const app = options.app ?? defaultAppFor(worker);
  const appDir = appDirFor(options.projectDir, app, worker);
  const { existing } = await guardAppDir(appDir, app, stub);
  // A backfill adds screens to an app that already holds a config: its rails and the adopter's other choices are
  // kept, and the rest is rewritten from the Worker, the way a sync does it.
  const current = existing ? await readAppConfig(appDir, app) : { text: null, previous: null };

  // The account chooser and the invitation screen read the session the sign-in screens hold.
  const screens = await resolveScreenSets({ ...options, needsAuth: ["organization"] });
  const rails = await resolveRails({
    flags: options.rails ?? {},
    backend: backendRails(options.config),
    scope: { projectDir: options.projectDir, workerDir: options.workerDir, worker },
    ...(options.railPrompt === undefined ? {} : { prompt: options.railPrompt }),
    ...(current.previous === null ? {} : { kept: current.previous.rails }),
  });

  const files = await loadStubFiles(stub, { worker, app, ...screens, packageManager });
  const built = buildGeneratedConfig({
    config: options.config,
    app,
    origins: await originsFor({
      projectDir: options.projectDir,
      workerDir: options.workerDir,
      config: options.config,
      deployedName: options.deployedName,
      environments: options.environments,
    }),
    rails,
  });
  const generated = { ...keepAdopterChoices(current.previous, built), rails };
  const config = renderGeneratedConfig(generated, worker);
  files[GENERATED_CONFIG_PATH] = config;

  if (existing) {
    let fresh = 0;
    for (const rel of Object.keys(files)) if (!(await pathExists(join(appDir, rel)))) fresh += 1;
    if (fresh === 0) {
      throw new ConflictError({
        message: `apps/${app} already has a ${stub.id} front end.`,
        action: `Run ${pithyCommand("ui sync", { flags: { "--app": app, "--worker": worker } })} to rewrite its config from ${worker}.`,
      });
    }
  }
  const kit = await kitRangesFor(
    importedKitPackages(files).filter((name) => !(name in stub.dependencies)),
    { projectDir: options.projectDir, workerDir: options.workerDir, ...options.kitRanges },
  );
  const packaged: UiStub = { ...stub, dependencies: { ...stub.dependencies, ...kit.ranges } };

  // The scaffold never overwrites, so a config already on disk is rewritten here instead.
  const { [GENERATED_CONFIG_PATH]: _, ...scaffolded } = files;
  const rewrite = current.text !== null;
  const write = async (projectDir: string, at: string) => {
    const written = await scaffoldFiles({
      workerDir: at,
      framework: stub.id,
      files: rewrite ? scaffolded : files,
      strict: !existing,
      retry: { "--app": app, "--worker": worker },
    });
    if (rewrite && config !== current.text) await writeFileAtomic(join(at, GENERATED_CONFIG_PATH), config);
    if (!(await pathExists(join(at, "package.json"))))
      await writeFileAtomic(join(at, "package.json"), starterPackage(app));
    await wireManifest(at, stub, packageManager, worker);
    const pkg = await wirePackage(projectDir, at, packaged);
    return { written, pkg };
  };

  let result: Awaited<ReturnType<typeof write>>;
  let planned: Plan | undefined;
  if (options.dryRun) {
    const run = await inShadow(options.projectDir, (shadow) => {
      const at = shadow.at(appDir);
      return withRollback({ root: shadow.root, paths: touchedPaths(at, files) }, () => write(shadow.root, at));
    });
    result = run.result;
    planned = { ...emptyPlan(), files: run.files, notes: run.notes };
  } else {
    result = await withRollback({ root: options.projectDir, paths: touchedPaths(appDir, files) }, () =>
      write(options.projectDir, appDir),
    );
  }

  return {
    worker,
    framework: stub.id,
    app,
    rails,
    trustedOrigins: trustedOriginsFor(generated),
    untrustedOrigins: untrustedOrigins(options.config, generated),
    unresolvedPackages: kit.unresolved,
    backfill: existing,
    ...screens,
    created: result.written.written,
    skipped: result.written.skipped,
    unstyled: [],
    runWorkerFirst: [],
    packageManager,
    dependencies: result.pkg.dependencies,
    devDependencies: result.pkg.devDependencies,
    scripts: result.pkg.scripts,
    ...(planned === undefined ? {} : { plan: planned }),
  };
}

/** The app `pithy ui sync --app` names, and the backend Worker its manifest says it calls. */
export async function nativeApp(projectDir: string, app: string): Promise<{ appDir: string; worker: string | null }> {
  const appDir = join(projectDir, "apps", app);
  const current = await readWorkerUi(appDir);
  if (current === null || current.stub !== "react-native") {
    throw new NotFoundError({
      message: `apps/${app} has no React Native front end.`,
      action: `Run ${commandName("ui add")} react-native --app ${app}, naming the worker it calls with --worker.`,
    });
  }
  return { appDir, worker: current.worker ?? null };
}

/**
 * Rewrite an app's `pithy-config.generated.ts` from the backend Worker's composed config, or — with `check` —
 * only report whether it has drifted.
 *
 * The projections and the origins are the Worker's and are rewritten, except an origin the adopter set where the
 * Worker names none. The scheme, the universal-link origin, the Google client ids and the rails are the adopter's
 * and are kept, except a rail a flag sets now. Every rail is checked against the backend, so one the Worker has
 * stopped enabling is refused by name. A sync against another Worker than the manifest names records that one.
 */
export async function runNativeUiSync(
  options: {
    projectDir: string;
    /** The app's directory, `apps/<app>`. */
    appDir: string;
    /** The backend Worker's directory. */
    workerDir: string;
    /** The backend Worker's loaded `pithy.config.ts`. */
    config: UiAddOptions["config"];
    /** The backend Worker's deployed name, which `.dev.config.json` keys its pinned origin by. */
    deployedName?: string;
    /** Report the drift and write nothing. */
    check?: boolean;
  } & Pick<RailChoices, "rails">,
): Promise<UiSyncReport> {
  const app = workerDirName({ dir: options.appDir });
  const worker = workerDirName({ dir: options.workerDir });
  const path = generatedConfigFile(options.appDir);
  const { text, previous } = await readAppConfig(options.appDir, app);

  const rails: PlatformRails = await resolveRails({
    flags: options.rails ?? {},
    backend: backendRails(options.config),
    scope: { projectDir: options.projectDir, workerDir: options.workerDir, worker },
    ...(previous === null ? {} : { kept: previous.rails }),
  });
  const next = buildGeneratedConfig({
    config: options.config,
    app,
    origins: await originsFor({
      projectDir: options.projectDir,
      workerDir: options.workerDir,
      config: options.config,
      deployedName: options.deployedName,
    }),
    rails,
  });
  const rendered = renderGeneratedConfig({ ...keepAdopterChoices(previous, next), rails }, worker);
  const retargeted = (await readWorkerUi(options.appDir))?.worker !== worker;
  const changed = rendered !== text;
  if (!options.check) {
    if (changed) await writeFileAtomic(path, rendered);
    if (retargeted) await rewireBackend(options.appDir, worker);
  }
  return {
    worker,
    app,
    rails,
    before: [],
    after: [],
    changed,
    uncovered: [],
    unstyled: [],
    notFoundHandling: undefined,
  };
}
