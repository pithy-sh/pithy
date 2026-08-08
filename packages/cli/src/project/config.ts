// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProfileOverride } from "@pithy-sh/cloudflare/src/tokens/profiles";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { fromZodError, InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { assertValidProjectName, kebab } from "@pithy-sh/core/src/naming/resource";
import { z } from "zod";
import { CloudflareAccountName } from "../cloudflare/config";
import { discoverWorkers } from "./workers";

/** Adopter token configuration: per-profile overrides of the predefined defaults (permissions/resources/store). */
export interface TokenConfig {
  /** Profile name → the fields to override on that profile's predefined default. */
  overrides?: Record<string, ProfileOverride>;
}

/** Adopter `pithy seed` configuration. */
export interface SeedProjectConfig {
  /**
   * Compose in `example`-flagged seed sets (tiny demo fixtures a capability ships for a quick look).
   * Default off — an adopter opts in per project, and an example set never targets production
   * regardless of this setting (its own `environments` allowlist excludes it).
   */
  includeExamples?: boolean;
  /**
   * Environment names this project treats as production, beyond the built-in `production`/`prod`.
   * Any env named here (case-insensitive) requires the hard type-to-confirm phrase, not just `--yes` —
   * so a project whose production environment is named `live`, `prod-eu`, `main`, etc. gets the same
   * strongest gate as the canonical names. List every production-class environment you run.
   */
  productionEnvironments?: readonly string[];
}

/**
 * The **root** `pithy.config.ts`: project identity and project-wide policy. It deliberately carries no
 * capabilities — what a Worker is *made of* is per-Worker and lives in `apps/<name>/pithy.config.ts`
 * ({@link WorkerConfig}). These three settings are the ones that cannot be per-Worker:
 *
 * - `name` is the first segment of every feature resource name and the only key teardown has to find them by,
 *   so it must be one stable value for the whole project.
 * - `tokens` configures account-level Cloudflare API token profiles.
 * - `seed.productionEnvironments` is a safety policy; a Worker must not be able to quietly omit it.
 */
export interface ProjectConfig {
  /**
   * The project name — a short, hyphenated-lowercase identifier (e.g. `acme`). It is the branch-first
   * prefix `pithy feature` names every Cloudflare resource under (`<project>-f<issue>-<slug>-<resource>`),
   * so the CF dashboard groups a feature's resources and teardown finds them by prefix. Optional; when
   * absent it falls back to the app Worker's `wrangler.jsonc` name, then the project directory name.
   */
  name?: string;
  /** Overrides for the predefined CF token profiles (`pithy token`). Optional. */
  tokens?: TokenConfig;
  /** `pithy seed` settings. Optional; defaults to no example seeds. */
  seed?: SeedProjectConfig;
  /**
   * Which Cloudflare account this project belongs to — `{ accountName?, accountId? }`, validated by
   * {@link loadProjectCloudflare}. Optional, and absent means exactly what it always meant: the
   * credentials come from `<config>/cloudflare.json`.
   *
   * Typed `unknown` for the same reason {@link WorkerConfig.domains} is: this file is the adopter's own
   * TypeScript, `loadProject` imports it live, and duck-typing is the only other gate on it — so an
   * unvalidated `accountName` would reach a `join` as whatever they typed.
   */
  cloudflare?: unknown;
}

/**
 * The root config's `cloudflare` block: **which Cloudflare account this project belongs to** (#206).
 *
 * `<config>/cloudflare.json` is account-scoped, on the reasoning that one account holds many projects
 * (#182). That reasoning is right and incomplete: it assumes one account per *machine*. A developer
 * working across two companies has two, and without this block every project on the machine reads the
 * same file — so switching accounts means editing that file in place and every project silently follows.
 *
 * **Strict, because a dropped key here is the whole failure mode.** A misspelled `accountid` that parsed
 * to "no pin" would leave the project with exactly the silent, unverified resolution the pin exists to
 * end, and nothing would say so.
 */
export const ProjectCloudflare = z
  .strictObject({
    accountName: CloudflareAccountName.optional().describe(
      "Selects <config>/cloudflare.<name>.json. Absent selects cloudflare.json, exactly as before.",
    ),
    accountId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The account this project belongs to. An identifier, not a secret — safe in a repository, including a public one — and verified against whatever the credentials resolve to.",
      ),
  })
  .describe("Which Cloudflare account this project's credentials must belong to, from the root pithy.config.ts.");

/** Which Cloudflare account this project belongs to. Same name as its schema, as every Zod object here is. */
export type ProjectCloudflare = z.output<typeof ProjectCloudflare>;

/**
 * Read and validate the root config's `cloudflare` declaration.
 *
 * Parsed rather than cast, on {@link loadWorkerDomains}'s argument and one more of its own: `accountName`
 * becomes a **file name** in the config directory, which sits outside every checkout — so
 * `ensureScaffoldPath` and the atomic writer, the two things that guard a path inside a project, never
 * see it. {@link CloudflareAccountName} is the gate, and this is where a project's config meets it.
 *
 * Absent is not an error; it is the ordinary state of a machine with one Cloudflare account.
 */
export function loadProjectCloudflare(config: ProjectConfig): ProjectCloudflare | undefined {
  if (config.cloudflare === undefined || config.cloudflare === null) return undefined;
  const parsed = ProjectCloudflare.safeParse(config.cloudflare);
  if (!parsed.success) {
    // The schema's own sentences are promoted into `message` rather than left in `issues`, because the
    // CLI's error renderer prints `message` and `action` and nothing else — and the whole point of the
    // rule living at the schema is that its refusal names the config and the value wherever it surfaces.
    throw fromZodError(parsed.error, {
      message: `The \`cloudflare\` block in pithy.config.ts is not valid. ${parsed.error.issues.map((issue) => issue.message).join(" ")}`,
      action:
        "Fix `cloudflare` in the root pithy.config.ts. It takes `accountName` (a bare token selecting <config>/cloudflare.<name>.json) and `accountId` (the account the project belongs to).",
    });
  }
  return parsed.data;
}

/**
 * One Worker's `apps/<name>/pithy.config.ts`: what *that* Worker is made of. Capabilities are per-Worker
 * because everything they drive is per-Worker — the composed route tree (`createEntrypoint`), the
 * `requiredBindings` written into that Worker's `wrangler.jsonc`, and Durable Object class migrations, which
 * register a class against a specific script. A Worker that only needs KV composes only what it declares.
 *
 * Workers share a resource by declaring the **same binding name**: feature resource names are derived from
 * `(project, issue, slug, binding, kind)` with no Worker segment, so two Workers that both declare `DB` are
 * backed by one D1, and a Worker wanting its own declares a different binding (e.g. `COLLAB_DB`).
 */
export interface WorkerConfig {
  /** Library capabilities this Worker composes, in order. `pithy add --worker <name>` registers them here. */
  capabilities: Capability[];
  /** This Worker's own app capability, composed last. */
  app?: Capability;
  /**
   * Where this Worker answers, per environment — the one declaration `routes`, `vars.BASE_URL`, and every
   * command that needs an address are derived from. Optional: a project without a domain yet is
   * legitimate, and adding one later is a config edit plus a deploy.
   *
   * Validated through {@link WorkerDomains} by {@link loadWorkerDomains} rather than trusted off the
   * import, because this file is the adopter's own TypeScript and nothing else checks it.
   */
  domains?: unknown;
}

/**
 * Read and validate a Worker's `domains` declaration.
 *
 * Parsed rather than cast: `pithy.config.ts` is the adopter's own module, `loadWorkerConfig` imports it
 * live, and duck-typing is the only other gate on it — so an unvalidated `domains` would reach the
 * wrangler generator as whatever they typed. A malformed declaration must fail with the field named,
 * not produce a `routes` entry Cloudflare rejects at deploy.
 *
 * Absent is not an error; it is the ordinary state of a project that has not wired a domain yet.
 */
export function loadWorkerDomains(config: WorkerConfig): WorkerDomains | undefined {
  if (config.domains === undefined || config.domains === null) return undefined;
  const parsed = WorkerDomains.safeParse(config.domains);
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: "This Worker's `domains` declaration is not valid.",
      action: "Fix `domains` in the Worker's pithy.config.ts. Each entry is `{ pattern, zone }` — bare hostnames.",
    });
  }
  return parsed.data;
}

function isWorkerConfig(value: unknown): value is WorkerConfig {
  return typeof value === "object" && value !== null && Array.isArray((value as WorkerConfig).capabilities);
}

function isProjectConfig(value: unknown): value is ProjectConfig {
  return typeof value === "object" && value !== null;
}

/** Import a `pithy.config.ts` and return its default export, with actionable errors for the two failure modes. */
async function importConfig(path: string, missing: () => never): Promise<unknown> {
  try {
    await access(path);
  } catch {
    missing();
  }

  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  } catch (cause) {
    // The file is present but could not be imported — most often its `@pithy-sh/*` imports do not resolve
    // because dependencies are not installed yet, or the config has a syntax/runtime error. Surface an
    // actionable error rather than the raw module-resolution stack (which every consumer would otherwise leak).
    throw new InternalError({
      message: `Could not load ${path}.`,
      action: "Install the project's dependencies (e.g. bun install), then check the config for errors.",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return module.default;
}

/**
 * Load one Worker's `apps/<name>/pithy.config.ts` — the capabilities that Worker composes. Imported live
 * (the config is code), so this runs under a TS-capable runtime; Phase 0 ships the bin on Bun.
 */
export async function loadWorkerConfig(workerDir: string): Promise<WorkerConfig> {
  const path = join(workerDir, "pithy.config.ts");
  const value = await importConfig(path, () => {
    throw new NotFoundError({
      message: `No pithy.config.ts in ${workerDir}.`,
      action: "Every worker under apps/ needs one. pithy worker add creates it.",
    });
  });
  if (!isWorkerConfig(value)) {
    throw new InternalError({
      message: `${path} doesn't default-export a worker config.`,
      action: "Export default { capabilities, app }.",
    });
  }
  return value;
}

/**
 * Load the **root** `pithy.config.ts` — the project's identity and policy. Capabilities are not here; they
 * live per Worker ({@link loadWorkerConfig}).
 */
export async function loadProject(projectDir: string): Promise<ProjectConfig> {
  const path = join(projectDir, "pithy.config.ts");
  const value = await importConfig(path, () => {
    throw new NotFoundError({
      message: "No pithy.config.ts here.",
      action: "Run from a Pithy project. pithy init creates one.",
    });
  });
  if (!isProjectConfig(value)) {
    throw new InternalError({
      message: "pithy.config.ts doesn't default-export a config.",
      action: "Export default { name }.",
    });
  }
  // Validated on every load, so a name that would not survive `CloudflareAccountName` refuses the
  // command that read the config rather than whichever later call happened to build a path out of it.
  // The value is *returned*, never published: an ambient account is what made six call sites resolve
  // credentials before anything had established which account they were for.
  loadProjectCloudflare(value);
  return value;
}

/**
 * The Cloudflare account a project belongs to, loaded from its root config — **the one way a command
 * gets an account to resolve credentials for.**
 *
 * `cloudflareEnv` takes the account as an argument rather than reading an ambient, and this is what
 * every caller passes it. Loading the project is the only way to learn the answer, so the two are one
 * call here: a command cannot resolve credentials "before" the project any more than it can call this
 * function without awaiting it.
 *
 * Throws what {@link loadProject} throws when there is no config here — a command that is inside a
 * project and cannot read its config has a worse problem than which account it is for. A caller that
 * legitimately has no project (`pithy init` before the scaffold exists) passes `null` instead of asking.
 */
export async function projectCloudflareAccount(projectDir: string): Promise<ProjectCloudflare | null> {
  return loadProjectCloudflare(await loadProject(projectDir)) ?? null;
}

/** Every capability one Worker composes, in order: libraries first, its app last. */
export function allCapabilities(config: WorkerConfig): Capability[] {
  return config.app ? [...config.capabilities, config.app] : [...config.capabilities];
}

/**
 * The project name, leniently guessed. Prefers the explicit `pithy.config.ts` `name`, then the first
 * discovered worker's `wrangler.jsonc` name, then the project directory's own name — always normalized
 * to hyphenated-lowercase. The fallbacks are **not stable**: `discoverWorkers` sorts alphabetically, so
 * adding an app that sorts earlier changes the guess, and the directory basename differs between a
 * worktree checkout and a normal clone. Fine for a cosmetic default; never use this where the name
 * feeds a naming convention another command must reproduce later — use {@link requireProjectName} there.
 */
export async function resolveProjectName(config: ProjectConfig, projectDir: string): Promise<string> {
  if (config.name) return kebab(config.name);
  const [worker] = await discoverWorkers(projectDir);
  if (worker) return kebab(worker.name);
  return kebab(basename(projectDir));
}

/**
 * The project name for the `pithy feature` resource-naming convention — the FIRST SEGMENT of every
 * Cloudflare resource name (`<project>-f<issue>-<slug>-<binding>-<kind>`) and the only key
 * `pithy feature destroy` has to find and delete them again. Unlike {@link resolveProjectName}, this
 * never guesses: it requires an explicit `pithy.config.ts` `name`, because any fallback that can differ
 * between machines or checkouts (an alphabetically-first worker, a worktree's directory basename) would
 * make teardown recompute names that match nothing, delete nothing, and exit 0 — a silent resource leak.
 * Throws an actionable `ValidationError` when `name` is absent.
 *
 * It also holds the name to `assertValidProjectName`, and that is the *second* half of the same guard.
 * `scaffoldProject` keeps a bad name from being created; this keeps an already-created one from getting
 * anywhere. Cloudflare's namespaces disagree about what a legal project segment is — D1, KV, and R2 take
 * a digit-leading name, Worker scripts and Workflows refuse it — so without this check `pithy add` and
 * `pithy migrate` provision real resources and only the first host-worker deploy fails, leaving a
 * half-provisioned project whose only documented fix orphans everything already created. Every command
 * resolves the project through here, so every command refuses on the first one instead.
 */
export function requireProjectName(config: ProjectConfig): string {
  if (!config.name) {
    throw new ValidationError({
      message: "pithy.config.ts has no `name`.",
      action:
        "Set `name` in pithy.config.ts. Every feature resource name — and pithy feature destroy's ability to find and delete it later — derives from this name, so it must stay stable across machines and checkouts.",
    });
  }
  assertValidProjectName(config.name);
  // `kebab` is core's, imported rather than reimplemented: a project name has to normalize identically
  // in every command that composes a resource name, and a second copy here would drift.
  return kebab(config.name);
}
