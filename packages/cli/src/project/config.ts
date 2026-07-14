import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProfileOverride } from "@pithy-sh/cloudflare/src/tokens/profiles";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";

/** Adopter token configuration: per-profile overrides of the predefined defaults (permissions/resources/store). */
export interface TokenConfig {
  /** Profile name → the fields to override on that profile's predefined default. */
  overrides?: Record<string, ProfileOverride>;
}

/** The shape `pithy.config.ts` default-exports: `createBackend`'s options, plus optional token config. */
export interface ProjectConfig {
  capabilities: Capability[];
  app?: Capability;
  /** Overrides for the predefined CF token profiles (`pithy token`). Optional. */
  tokens?: TokenConfig;
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
