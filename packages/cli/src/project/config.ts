import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProfileOverride } from "@pithy-sh/cloudflare/src/tokens/profiles";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
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

/** The shape `pithy.config.ts` default-exports: `createBackend`'s options, plus optional token config. */
export interface ProjectConfig {
  /**
   * The project name — a short, hyphenated-lowercase identifier (e.g. `acme`). It is the branch-first
   * prefix `pithy feature` names every Cloudflare resource under (`<project>-f<issue>-<slug>-<resource>`),
   * so the CF dashboard groups a feature's resources and teardown finds them by prefix. Optional; when
   * absent it falls back to the app Worker's `wrangler.jsonc` name, then the project directory name.
   */
  name?: string;
  capabilities: Capability[];
  app?: Capability;
  /** Overrides for the predefined CF token profiles (`pithy token`). Optional. */
  tokens?: TokenConfig;
  /** `pithy seed` settings. Optional; defaults to no example seeds. */
  seed?: SeedProjectConfig;
}

function isProjectConfig(value: unknown): value is ProjectConfig {
  return typeof value === "object" && value !== null && Array.isArray((value as ProjectConfig).capabilities);
}

/**
 * Load a project's `pithy.config.ts` — the CLI's view of what the backend is
 * made of. Imported live (the config is code), so this runs under a TS-capable
 * runtime; Phase 0 ships the bin on Bun.
 */
export async function loadProject(projectDir: string): Promise<ProjectConfig> {
  const path = join(projectDir, "pithy.config.ts");
  try {
    await access(path);
  } catch {
    throw new NotFoundError({
      message: "No pithy.config.ts here.",
      action: "Run from a Pithy project. pithy init creates one.",
    });
  }

  const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  if (!isProjectConfig(module.default)) {
    throw new InternalError({
      message: "pithy.config.ts doesn't default-export a config.",
      action: "Export default { capabilities, app }.",
    });
  }
  return module.default;
}

/** Every capability in composition order: libraries first, the app last. */
export function allCapabilities(config: ProjectConfig): Capability[] {
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
  if (config.name) return kebabName(config.name);
  const [worker] = await discoverWorkers(projectDir);
  if (worker) return kebabName(worker.name);
  return kebabName(basename(projectDir));
}

/**
 * The project name for the `pithy feature` resource-naming convention — the FIRST SEGMENT of every
 * Cloudflare resource name (`<project>-f<issue>-<slug>-<binding>-<kind>`) and the only key
 * `pithy feature destroy` has to find and delete them again. Unlike {@link resolveProjectName}, this
 * never guesses: it requires an explicit `pithy.config.ts` `name`, because any fallback that can differ
 * between machines or checkouts (an alphabetically-first worker, a worktree's directory basename) would
 * make teardown recompute names that match nothing, delete nothing, and exit 0 — a silent resource leak.
 * Throws an actionable `ValidationError` when `name` is absent.
 */
export function requireProjectName(config: ProjectConfig): string {
  if (!config.name) {
    throw new ValidationError({
      message: "pithy.config.ts has no `name`.",
      action:
        "Set `name` in pithy.config.ts. Every feature resource name — and pithy feature destroy's ability to find and delete it later — derives from this name, so it must stay stable across machines and checkouts.",
    });
  }
  return kebabName(config.name);
}

/** Lowercase, collapse any run of non-`[a-z0-9]` to one `-`, and trim leading/trailing `-`. */
function kebabName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
