import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProfileOverride } from "@pithy-sh/cloudflare/src/tokens/profiles";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
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
 * The project name for the `pithy feature` resource-naming convention. Prefers the explicit
 * `pithy.config.ts` `name`, then the app Worker's `wrangler.jsonc` name, then the project directory's
 * own name — always normalized to hyphenated-lowercase so it is a valid CF resource-name prefix.
 */
export async function resolveProjectName(config: ProjectConfig, projectDir: string): Promise<string> {
  if (config.name) return kebabName(config.name);
  const [worker] = await discoverWorkers(projectDir);
  if (worker) return kebabName(worker.name);
  return kebabName(basename(projectDir));
}

/** Lowercase, collapse any run of non-`[a-z0-9]` to one `-`, and trim leading/trailing `-`. */
function kebabName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
