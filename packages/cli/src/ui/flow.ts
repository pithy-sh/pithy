// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, join } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { allCapabilities, projectEnvironments, type WorkerConfig } from "../project/config";
import { detectPackageManager, type PackageManager } from "../project/packageManager";
import { readOptionalFile } from "../project/readOptionalFile";
import { withRollback } from "../project/rollback";
import { pathExists } from "../project/scaffold";
import { deriveWorkerFirst, uncoveredRoutes } from "./routeAllowlist";
import { scaffoldFiles } from "./scaffold";
import { PITHY_SCREEN_DIR, unstyledScreenClasses } from "./screenStyles";
import { resolveStub, UI_STUBS, type UiStub } from "./stubs";
import { loadStubFiles } from "./templates";
import { readAssets, wireAssets, wireManifest, wirePackage, wireSolution } from "./wire";
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

/**
 * The one name this file uses for a Worker: the directory it lives in, `apps/<name>`.
 *
 * Derived here rather than accepted as an argument, because a Worker has **two** names and the wrong one
 * is what a caller has to hand. `ResolvedWorker.name` is the *deployed* name — `<project>-<worker>`, the
 * string in `wrangler.jsonc` — and taking it wrote `apps/<project>-<worker>/tsconfig.client.json` into the
 * root solution file, a reference to a directory that has never existed. `tsc -b` stops on it with TS6053
 * and Vite refuses to load the Worker's `vite.config.ts`, so a freshly scaffolded project could neither
 * typecheck nor start.
 *
 * Everything below is either a path or a `--worker` value, and both are the directory. The deployed name
 * belongs in `wrangler.jsonc` and nowhere else.
 */
function workerName(workerDir: string): string {
  return basename(workerDir);
}

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
  /** The target worker's directory, `apps/<name>` — which is also where its name comes from. */
  workerDir: string;
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
  /**
   * Class names Pithy's screens render that nothing in this Worker's stylesheets defines — empty on
   * every ordinary run, and the exact list to fix when it is not.
   *
   * Separate from {@link created} because "wrote the screens" and "the screens are styled" are two
   * claims and only one of them was ever reported. A backfill writes `routes/pithy/sign-in.tsx` and
   * correctly skips the adopter's `src/styles.css`; if the rules those screens need are not on disk,
   * the run said `created` and the adopter met an unstyled login page with nothing pointing at why.
   *
   * Measured against the files as they stand **after** the write, not against the template, because
   * the template is not what renders: a stylesheet the adopter has since edited, or deleted, is the
   * case this exists for.
   */
  unstyled: string[];
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
    const worker = workerName(options.workerDir);
    throw new ValidationError({
      message: `The ${screens} screens need the ${screens} capability, and ${worker} doesn't compose it.`,
      action: `Run pithy add ${screens} --worker ${worker} first, or leave them out with --no-${screens}.`,
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
  const worker = workerName(options.workerDir);
  const files = await loadStubFiles(stub, {
    worker,
    ...screens,
    packageManager: options.packageManager ?? "npm",
  });
  if (!current) return { files, strict: true };

  if (current.stub !== stub.id) {
    throw new ConflictError({
      message: `${worker} already has a ${current.stub} front end.`,
      action: "One worker, one front end. Remove it, or add the new one to a different worker with --worker.",
    });
  }

  // `pathExists`, the shared `lstat`, and not the local `access` this used to roll. `access` follows a
  // link, so a dangling one planted at a template path answered "nothing there" — the file counted as
  // fresh, and the plan handed it to `scaffoldFiles` to write. That is the same predicate five other
  // modules got wrong, in the one module the tripwire could not see because it imports no writer of its
  // own. One question, one implementation.
  let fresh = 0;
  for (const rel of Object.keys(files)) {
    if (!(await pathExists(join(options.workerDir, rel)))) fresh += 1;
  }
  if (fresh === 0) {
    throw new ConflictError({
      message: `${worker} already has a ${current.stub} front end.`,
      action: "Add screens by dropping files into src/routes/app/. Run pithy ui sync to re-derive its route allowlist.",
    });
  }
  // The whole record, non-strict: the writer skips what exists and reports it, so the run says what
  // it added AND what it left alone.
  return { files, strict: false };
}

/**
 * Whether the screens this run just wrote will render styled, read off the worker as it now stands.
 *
 * The template's own files are not the answer. On a backfill the plan still carries Pithy's
 * `src/styles.css`, while the file on disk is the adopter's — so checking the plan would report a
 * screen as styled by rules that exist in this process and nowhere else. Only the disk renders.
 */
async function unstyledOnDisk(workerDir: string, planned: Record<string, string>): Promise<string[]> {
  const onDisk: Record<string, string> = {};
  for (const path of Object.keys(planned)) {
    const stylesheet = path.endsWith(".css");
    const screen = path.startsWith(PITHY_SCREEN_DIR) && path.endsWith(".tsx");
    if (!stylesheet && !screen) continue;
    const contents = await readOptionalFile(join(workerDir, path));
    if (contents !== null) onDisk[path] = contents;
  }
  return unstyledScreenClasses(onDisk);
}

/**
 * Every file this run may create or edit, absolute — what a failure has to put back.
 *
 * The template's own paths, plus the four documents `ui/wire.ts` edits rather than creates. Stated here
 * rather than discovered afterwards, because a rollback that guesses is one that misses a file.
 */
function touchedPaths(options: UiAddOptions, planned: Record<string, string>): string[] {
  return [
    ...Object.keys(planned).map((rel) => join(options.workerDir, rel)),
    join(options.workerDir, "wrangler.jsonc"),
    join(options.workerDir, "pithy.worker.jsonc"),
    join(options.workerDir, "package.json"),
    join(options.projectDir, "tsconfig.json"),
  ];
}

/**
 * Scaffold a front end into one worker and wire it end to end: the client files, the `assets` stanza
 * that serves them, the dev command `pithy dev` runs, the build command `pithy deploy` runs, and the
 * packages the build needs. The SPA and the API stay one deploy on one origin.
 *
 * **A run that fails leaves the project as it found it**, and that is two things rather than one.
 *
 * The allowlist is derived *before* anything is written: composing the app is the step most likely to
 * throw — a capability misconfigured, a required binding missing (#258), a syntax error in a file the
 * adopter has edited — and it used to run after the whole template had landed. So a failure left the
 * files written, the wiring absent, and the retry refused by this command's own "already has a front
 * end" guard, which cannot tell a finished front end from one abandoned a minute ago (#259).
 *
 * And every write after that runs under {@link withRollback}, because ordering alone only removes the
 * failure anyone has already seen: the next step added goes back on the end of the list, and the
 * property quietly stops being true. Stated over the outcome, it survives the next step.
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
  // Compose first. `deriveWorkerFirst` assembles every capability's routes, once per environment, and
  // reads nothing this run is about to write — which is what makes moving it ahead of the write legal.
  const patterns = deriveWorkerFirst(options.config, await projectEnvironments(options.projectDir));

  const scope = { root: options.projectDir, paths: touchedPaths(options, plan.files) };
  const result = await withRollback(scope, async () => {
    const written = await scaffoldFiles({ workerDir: options.workerDir, files: plan.files, strict: plan.strict });
    const assets = await wireAssets(options.workerDir, patterns);
    await wireManifest(options.workerDir, stub, packageManager);
    const pkg = await wirePackage(options.projectDir, options.workerDir, stub);
    // Last, and project-wide rather than per-worker: the client's programs join the root solution file so
    // `bun run typecheck` builds them. Two tsconfigs nothing references are two tsconfigs nothing checks.
    await wireSolution(options.projectDir, workerName(options.workerDir));
    // Read inside the scope, because it reads the files this block just wrote — outside, a rollback
    // would already have taken them away.
    const unstyled = await unstyledOnDisk(options.workerDir, plan.files);
    return { written, assets, pkg, unstyled };
  });

  return {
    worker: workerName(options.workerDir),
    framework: stub.id,
    auth,
    payments,
    created: result.written.written,
    skipped: result.written.skipped,
    unstyled: result.unstyled,
    runWorkerFirst: result.assets.after,
    packageManager,
    dependencies: result.pkg.dependencies,
    devDependencies: result.pkg.devDependencies,
    scripts: result.pkg.scripts,
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
   * Routes the allowlist **in the file** does not cover: the ones the SPA shell is answering with a 200
   * and the wrong body. Always empty after a write — the run just re-derived the list — so this is the
   * finding `--check` exists to produce, and the one thing that fails the exit.
   */
  uncovered: string[];
  /**
   * `assets.not_found_handling` as it stands. Reported because SPA routing depends on it: an adopter
   * who set it to something else has deep links 404ing in Hono rather than serving the app shell, and
   * `ui sync` does not overwrite a value they chose.
   */
  notFoundHandling: string | undefined;
}

/**
 * Re-derive one worker's `assets.run_worker_first` from its current route table, or — with `check` —
 * only report how far the file has drifted from it.
 *
 * The allowlist is written once, at `pithy ui add`, and every route mounted afterwards is a route the
 * asset router answers before the worker runs. `pithy add <capability>` is one way that happens; the
 * adopter writing a route into their own app capability is the other, and that one runs no command at
 * all. So the allowlist has to be re-derivable on demand *and* checkable in CI, because a list that
 * has gone stale does not fail — it returns 200 with the SPA shell.
 *
 * Creates no files either way, and re-running changes nothing.
 */
export async function runUiSync(options: {
  /** The project root — where the `environments` declaration the derivation needs lives. */
  projectDir: string;
  /** The target worker's directory, `apps/<name>` — which is also where its name comes from. */
  workerDir: string;
  /** The target worker's loaded `pithy.config.ts`. */
  config: WorkerConfig;
  /** Report the drift and write nothing — the CI gate. */
  check?: boolean;
}): Promise<UiSyncReport> {
  const worker = workerName(options.workerDir);
  const current = await readWorkerUi(options.workerDir);
  if (!current) {
    throw new NotFoundError({
      message: `${worker} has no front end.`,
      action: `Run pithy ui add react --worker ${worker} to scaffold one.`,
    });
  }

  const environments = await projectEnvironments(options.projectDir);
  const after = deriveWorkerFirst(options.config, environments);
  if (options.check) {
    const assets = await readAssets(options.workerDir);
    return {
      worker,
      before: assets.runWorkerFirst,
      after,
      changed: assets.runWorkerFirst.join("\n") !== after.join("\n") || assets.notFoundHandling === undefined,
      uncovered: uncoveredRoutes(options.config, assets.runWorkerFirst, environments),
      notFoundHandling: assets.notFoundHandling,
    };
  }

  // `after` above is the same derivation the write needs, so it is computed once and handed over —
  // and, incidentally, before anything is written here too.
  const change = await wireAssets(options.workerDir, after);
  const before = change.before ?? [];
  return {
    worker,
    before,
    after: change.after,
    // Every way this call can have moved the file, not just the allowlist — a report that says
    // nothing changed while the file did is worse than no report, because CI keys off it.
    changed: before.join("\n") !== change.after.join("\n") || change.wroteNotFoundHandling,
    // The list was just re-derived from this same route table, so nothing is left outside it.
    uncovered: [],
    notFoundHandling: change.notFoundHandling,
  };
}
