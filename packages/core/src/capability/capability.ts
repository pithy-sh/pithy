import type { Hono } from "hono";
import type { MigrationProvider } from "kysely/migration";
import type { z } from "zod";
import type { AuthContext } from "../http/authContext";
import { BindingSpec, type BindingSpecInput } from "./bindings";

/** Hono `Variables` every capability's routes are typed against. Extended in the createBackend plan. */
export interface PithyVars {
  auth: AuthContext | null;
}

/** The Hono env. `Bindings` and `Variables` are placeholders here — typed per app in the createBackend plan. */
export type PithyHonoEnv = { Bindings: Record<string, unknown>; Variables: PithyVars };

export type PithyMiddleware = (app: Hono<PithyHonoEnv>) => void;

/** A registered durable job (Cloudflare Workflow) — wired fully in a later phase. */
export interface WorkflowSpec {
  name: string;
  /** The binding name of the Workflow in the Worker env. */
  binding: string;
}

/**
 * The single composition contract. `core`, each capability, and the app all implement it,
 * contributing any subset of {config, migrations, routes, middleware, workflows, bindings}.
 * Capabilities depend on core seams (e.g. AuthContext), never on each other's internals.
 */
export interface Capability {
  name: string;
  /** Validated env/config/secrets for this capability. */
  config?: z.ZodType;
  /** Namespaced Kysely migration provider (see migrations/registry). */
  migrations?: MigrationProvider;
  /** Sort order for this capability's migrations relative to others (core low, app high). */
  migrationOrder?: number;
  /** Mounts a Hono sub-router. */
  routes?: (app: Hono<PithyHonoEnv>) => void;
  /** Composable middleware (e.g. turnstile(), requireAuth()). */
  middleware?: PithyMiddleware[];
  /** Durable jobs this capability registers. */
  workflows?: WorkflowSpec[];
  /** Bindings this capability needs in the env (normalized — `optional` is always set). */
  requiredBindings: BindingSpec[];
}

/** Authoring shape: `requiredBindings` may omit `optional`; `defineCapability` normalizes them. */
export type CapabilityInput = Omit<Capability, "requiredBindings"> & {
  requiredBindings: BindingSpecInput[];
};

/**
 * Author a capability. Parses each binding through `BindingSpec` — normalizing `optional`
 * and validating at define time, so an invalid binding fails here (attributed to this
 * capability) rather than deep in backend assembly.
 */
export function defineCapability(input: CapabilityInput): Capability {
  return {
    ...input,
    requiredBindings: input.requiredBindings.map((binding) => BindingSpec.parse(binding)),
  };
}
