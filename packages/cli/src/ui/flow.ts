import { access } from "node:fs/promises";
import { join } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { allCapabilities, type WorkerConfig } from "../project/config";
import { detectPackageManager, type PackageManager } from "../project/packageManager";
import { scaffoldFiles } from "./scaffold";
import { resolveStub, UI_STUBS, type UiStub } from "./stubs";
import { loadStubFiles } from "./templates";
import { wireAssets, wireManifest, wirePackage } from "./wire";
import { readWorkerUi } from "./workerUi";

/**
 * `pithy ui add` and `pithy ui sync`, as flows — the command file stays argument parsing and output,
 * the way `capabilities/flow.ts` sits behind `pithy add`.
 */

/** The capability the auth template's screens are written against. */
const AUTH_CAPABILITY = "auth";

/** The capability the paywall and subscription screens are written against. */
const PAYMENTS_CAPABILITY = "payments";

/** Which capability-gated screen set a decision is about. */
export type UiScreenSet = typeof AUTH_CAPABILITY | typeof PAYMENTS_CAPABILITY;

/**
 * Ask whether to scaffold one capability's screens.
 *
 * One seam for every screen set rather than one per set: a third capability's screens must be a new member
 * of {@link UiScreenSet} and nothing else, and a prompt-per-capability is exactly the shape that stops
 * being true.
 */
export type UiScreenPrompt = (request: { screens: UiScreenSet; suggestion: boolean }) => Promise<boolean>;

/** One entry of `pithy ui list`. */
export interface UiStubListing {
  /** The `<framework>` positional. */
  id: string;
  /** One line describing what it scaffolds. */
  description: string;
}

/** Every framework `pithy ui add` can scaffold, sorted. */
export function listStubs(): UiStubListing[] {
  return Object.values(UI_STUBS)
    .map((stub) => ({ id: stub.id, description: stub.description }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Options for {@link runUiAdd} — the target worker, already resolved, plus the choices. */
export interface UiAddOptions {
  /** The project root — where the lockfile that names the package manager lives. */
  projectDir: string;
  /** The target worker's directory, `apps/<name>`. */
  workerDir: string;
  /** The target worker's name. */
  worker: string;
  /** The target worker's loaded `pithy.config.ts` — the route table the allowlist is derived from. */
  config: WorkerConfig;
  /** The `<framework>` positional. */
  framework: string;
  /** `--auth` / `--no-auth`. Undefined means "decide", by prompt when one is attached. */
  auth?: boolean;
  /** `--payments` / `--no-payments`. Undefined means "decide", the same way. */
  payments?: boolean;
  /**
   * Ask whether to scaffold a capability's screens. Supplied only when a human is attached; without it
   * every decision falls to whether that capability is composed, so no invocation can ever block.
   */
  prompt?: UiScreenPrompt;
  /** Package-manager override. Tests set it; otherwise it is detected from the project's lockfile. */
  packageManager?: PackageManager;
}

/** What `pithy ui add` did. */
export interface UiAddReport {
  /** The worker the front end landed in. */
  worker: string;
  /** The stub that wrote it. */
  framework: string;
  /** Whether the auth template was included. */
  auth: boolean;
  /** Whether the payments screens were included. */
  payments: boolean;
  /** Worker-relative paths created by this run, sorted. */
  created: string[];
  /** Worker-relative paths that already existed and were left byte-identical, sorted. */
  skipped: string[];
  /** The derived `assets.run_worker_first` allowlist now in `wrangler.jsonc`. */
  runWorkerFirst: string[];
  /** The project's package manager. */
  packageManager: PackageManager;
  /** Dependency names added to the worker's `package.json`. */
  dependencies: string[];
  /** Dev-dependency names added to the worker's `package.json`. */
  devDependencies: string[];
  /** Script names added (or superseded, for a `dev` that still held `wrangler dev`). */
  scripts: string[];
}

/** True if `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether to write one capability's screens. `--auth`/`--no-auth` and `--payments`/`--no-payments` decide
 * outright. With neither, a human is asked (defaulting to yes when the capability is composed on this
 * worker) and anyone else — `--json`, an agent, CI — gets that same default with no prompt, because no
 * invocation may block.
 *
 * Asking for a capability's screens on a worker that does not compose it is an error, not a scaffold of
 * broken imports.
 */
async function resolveScreens(
  options: UiAddOptions,
  screens: UiScreenSet,
  requested: boolean | undefined,
  composed: boolean,
): Promise<boolean> {
  let wanted = requested;
  if (wanted === undefined)
    wanted = options.prompt ? await options.prompt({ screens, suggestion: composed }) : composed;
  if (wanted && !composed) {
    throw new ValidationError({
      message: `The ${screens} screens need the ${screens} capability, and ${options.worker} doesn't compose it.`,
      action: `Run pithy add ${screens} --worker ${options.worker} first, or leave them out with --no-${screens}.`,
    });
  }
  return wanted;
}

/** Whether a worker composes a capability by name. */
function composes(config: WorkerConfig, capability: string): boolean {
  return allCapabilities(config).some((composed) => composed.name === capability);
}

/**
 * The files this run may write: the whole template on a first scaffold, and only what does not exist
 * yet on a backfill (`--auth` after `--no-auth`).
 *
 * A worker that already carries a front end and gains nothing new is the "adding a UI twice" error —
 * clean and actionable, never a partial overwrite. A worker carrying a *different* stub is refused
 * outright: two frameworks in one worker is not a merge anyone should attempt for you.
 */
async function planFiles(
  options: UiAddOptions,
  stub: UiStub,
  screens: { auth: boolean; payments: boolean },
): Promise<{ files: Record<string, string>; strict: boolean }> {
  const current = await readWorkerUi(options.workerDir);
  const files = await loadStubFiles(stub, {
    worker: options.worker,
    ...screens,
    packageManager: options.packageManager ?? "npm",
  });
  if (!current) return { files, strict: true };

  if (current.stub !== stub.id) {
    throw new ConflictError({
      message: `${options.worker} already has a ${current.stub} front end.`,
      action: "One worker, one front end. Remove it, or add the new one to a different worker with --worker.",
    });
  }

  let fresh = 0;
  for (const rel of Object.keys(files)) {
    if (!(await exists(join(options.workerDir, rel)))) fresh += 1;
  }
  if (fresh === 0) {
    throw new ConflictError({
      message: `${options.worker} already has a ${current.stub} front end.`,
      action: "Add screens by dropping files into src/routes/app/. Run pithy ui sync to re-derive its route allowlist.",
    });
  }
  // The whole record, non-strict: the writer skips what exists and reports it, so the run says what
  // it added AND what it left alone.
  return { files, strict: false };
}

/**
 * Scaffold a front end into one worker and wire it end to end: the client files, the `assets` stanza
 * that serves them, the dev command `pithy dev` runs, the build command `pithy deploy` runs, and the
 * packages the build needs. The SPA and the API stay one deploy on one origin.
 */
export async function runUiAdd(options: UiAddOptions): Promise<UiAddReport> {
  const stub = resolveStub(options.framework);
  const packageManager = options.packageManager ?? (await detectPackageManager(options.projectDir));
  const auth = await resolveScreens(options, AUTH_CAPABILITY, options.auth, composes(options.config, AUTH_CAPABILITY));
  const payments = await resolveScreens(
    options,
    PAYMENTS_CAPABILITY,
    options.payments,
    composes(options.config, PAYMENTS_CAPABILITY),
  );

  const plan = await planFiles({ ...options, packageManager }, stub, { auth, payments });
  const written = await scaffoldFiles({ workerDir: options.workerDir, files: plan.files, strict: plan.strict });

  const assets = await wireAssets(options.workerDir, options.config);
  await wireManifest(options.workerDir, stub, packageManager);
  const pkg = await wirePackage(options.workerDir, stub);

  return {
    worker: options.worker,
    framework: stub.id,
    auth,
    payments,
    created: written.written,
    skipped: written.skipped,
    runWorkerFirst: assets.after,
    packageManager,
    dependencies: pkg.dependencies,
    devDependencies: pkg.devDependencies,
    scripts: pkg.scripts,
  };
}

/** What `pithy ui sync` did. */
export interface UiSyncReport {
  /** The worker whose allowlist was re-derived. */
  worker: string;
  /** The allowlist before this run. */
  before: string[];
  /** The allowlist after it. */
  after: string[];
  /** Whether anything actually moved — false on a re-run, which is the point. */
  changed: boolean;
  /**
   * `assets.not_found_handling` as it stands. Reported because SPA routing depends on it: an adopter
   * who set it to something else has deep links 404ing in Hono rather than serving the app shell, and
   * `ui sync` does not overwrite a value they chose.
   */
  notFoundHandling: string | undefined;
}

/**
 * Re-derive one worker's `assets.run_worker_first` from its current route table. `pithy add
 * <capability>` mounts new routes, and a route the asset router answers first is a route that never
 * reaches the worker — so the allowlist has to be re-derivable on demand. Creates no files, and
 * re-running changes nothing.
 */
export async function runUiSync(options: {
  /** The target worker's directory, `apps/<name>`. */
  workerDir: string;
  /** The target worker's name. */
  worker: string;
  /** The target worker's loaded `pithy.config.ts`. */
  config: WorkerConfig;
}): Promise<UiSyncReport> {
  const current = await readWorkerUi(options.workerDir);
  if (!current) {
    throw new NotFoundError({
      message: `${options.worker} has no front end.`,
      action: `Run pithy ui add react --worker ${options.worker} to scaffold one.`,
    });
  }

  const change = await wireAssets(options.workerDir, options.config);
  const before = change.before ?? [];
  return {
    worker: options.worker,
    before,
    after: change.after,
    // Every way this call can have moved the file, not just the allowlist — a report that says
    // nothing changed while the file did is worse than no report, because CI keys off it.
    changed: before.join("\n") !== change.after.join("\n") || change.wroteNotFoundHandling,
    notFoundHandling: change.notFoundHandling,
  };
}
