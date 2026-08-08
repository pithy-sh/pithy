// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative } from "node:path";
import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { z } from "zod";
import { cloudflareEnv } from "../cloudflare/config";
import type { StatePathOptions } from "../notifier/state";
import { loadWorkerConfig, loadWorkerDomains } from "./config";
import { dashboardListUrl, dashboardUrl } from "./dashboard";
import { resolveWorkerAddress } from "./workerAddress";
import { discoverWorkers as discoverWorkersDefault, type WorkerTarget } from "./workers";
import { readWranglerConfig } from "./wrangler";

/**
 * The read-only inventory behind `pithy env`. Every Worker lives in `apps/<name>/` with its **own**
 * `wrangler.jsonc`, so the inventory is per Worker × per environment: for each Worker, the top-level
 * stanza is its `dev` environment and each `env.<name>` is another (staging, production). For every
 * environment it reports each binding, its resolved id, whether that resource is provisioned, the
 * environment's base URL, and a Cloudflare dashboard link per linkable resource. It writes nothing
 * and never fails on a not-provisioned resource — provisioning health belongs to `pithy doctor`.
 *
 * Discovery reads `apps/` directly, and the environment set still comes from `wrangler.jsonc` alone — an
 * inventory must print in a project whose dependencies are not installed. A Worker's `pithy.config.ts` is
 * read only for its `domains` declaration, and only ever opportunistically: a config that is missing,
 * unimportable, or carries a malformed `domains` block leaves the declaration unresolved and the
 * wrangler-derived report intact. A discovered process with no `wrangler.jsonc` (a Vite frontend in the
 * dev set) has no environments and is skipped.
 */

/** The wrangler binding array key and id field for each id-carrying resource kind (mirrors feature/wranglerEnv.ts KIND_TO_WRANGLER). */
type ResourceKind = "d1" | "kv" | "r2" | "durable_object";

/** One binding entry as it appears in a wrangler.jsonc binding array; only the id field for its kind is populated. */
interface RawBinding {
  binding?: string;
  database_id?: string;
  id?: string;
  bucket_name?: string;
}

/** A durable-object binding: the binding name and the class it resolves to. */
interface RawDurableObjectBinding {
  name?: string;
  class_name?: string;
}

/** A route entry — either a bare pattern string or the object form wrangler also accepts. */
type RawRoute = string | { pattern?: string };

/** One wrangler environment stanza (the top-level doc is the `dev` stanza; each `env.<name>` is another). */
interface RawStanza {
  name?: string;
  d1_databases?: RawBinding[];
  kv_namespaces?: RawBinding[];
  r2_buckets?: RawBinding[];
  durable_objects?: { bindings?: RawDurableObjectBinding[] };
  route?: RawRoute;
  routes?: RawRoute[];
}

/** The parsed wrangler.jsonc: the top-level `dev` stanza plus the named `env.*` stanzas. */
interface RawWrangler extends RawStanza {
  env?: Record<string, RawStanza | undefined>;
}

export const EnvResource = z
  .object({
    kind: z.enum(["d1", "kv", "r2", "durable_object"]).describe("The Cloudflare resource kind backing this binding."),
    binding: z.string().describe("The Worker binding name, e.g. DB or SESSIONS."),
    id: z
      .string()
      .nullable()
      .describe(
        "The resolved resource id (D1 uuid, KV namespace id, R2 bucket name, DO class name), or null when absent.",
      ),
    provisioned: z
      .boolean()
      .describe("True when the id is present, non-empty, and not a placeholder — i.e. the resource actually exists."),
    dashboardUrl: z
      .string()
      .nullable()
      .describe(
        "The Cloudflare dashboard link for this resource — its own page when the id is knowable, else that product's list page. Null with no account id, when not provisioned, or for a kind with neither.",
      ),
  })
  .describe("One binding in an environment: its kind, resolved id, provisioned state, and dashboard link.");
export type EnvResource = z.output<typeof EnvResource>;

export const EnvironmentReport = z
  .object({
    name: z.string().describe('The environment name: "dev" for the top-level stanza, else the env.<name> key.'),
    scriptName: z
      .string()
      .nullable()
      .describe(
        "The Worker script name this environment deploys under (root name for dev, env.<name>.name otherwise), or null.",
      ),
    baseUrl: z
      .string()
      .nullable()
      .describe(
        'The environment\'s base URL: "local" for dev (there is no public address for a local run), else resolved in order from the `domains` declaration, the first route pattern, and a hand-set `vars.BASE_URL` — or null when the Worker declares no address at all.',
      ),
    workerDashboardUrl: z
      .string()
      .nullable()
      .describe(
        "The Cloudflare dashboard link for this environment's Worker, or null with no account id or script name.",
      ),
    resources: z.array(EnvResource).describe("Every binding declared for this environment."),
  })
  .describe("One environment's Worker identity, base URL, and full binding inventory.");
export type EnvironmentReport = z.output<typeof EnvironmentReport>;

export const WorkerEnvironments = z
  .object({
    worker: z.string().describe("The Worker's name, as `pithy worker list` shows it."),
    dir: z.string().describe("The Worker's directory, relative to the project root (e.g. apps/api)."),
    environments: z
      .array(EnvironmentReport)
      .describe("Every environment declared in this Worker's wrangler.jsonc, dev first."),
  })
  .describe("One Worker's environments — each Worker under apps/ carries its own wrangler.jsonc.");
export type WorkerEnvironments = z.output<typeof WorkerEnvironments>;

export const EnvInventory = z
  .object({
    accountId: z
      .string()
      .nullable()
      .describe(
        "The Cloudflare account id (from .dev.vars or the environment), or null — dashboard links are omitted when absent.",
      ),
    workers: z
      .array(WorkerEnvironments)
      .describe("Every Worker with a wrangler.jsonc, in discovery order, each with its own environments."),
  })
  .describe(
    "The read-only `pithy env` inventory: every Worker's environments, their bindings, resolved ids, provisioned state, and dashboard links.",
  );
export type EnvInventory = z.output<typeof EnvInventory>;

/** A value is not provisioned if it is empty or a placeholder token like `<database_id>`. */
function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || /^<.+>$/.test(trimmed) || /placeholder/i.test(trimmed);
}

/** Build one resource report, resolving provisioned state and the dashboard link (only for a provisioned, linkable kind with an account id). */
function makeResource(
  kind: ResourceKind,
  binding: string | undefined,
  rawId: string | undefined,
  accountId: string | null,
  /**
   * The id the **dashboard** addresses this resource by, when that differs from the id we display.
   * Omit it when they are the same. Pass `null` when the project cannot know it — the resource then
   * falls back to that product's list page rather than a deep link built from the wrong identifier,
   * which would look authoritative and land on a 404.
   */
  linkId?: string | null,
): EnvResource {
  const id = rawId ?? null;
  const provisioned = id !== null && !isPlaceholder(id);
  const target = linkId === undefined ? id : linkId;
  // With a dashboard id, link straight at the resource. Without one — a Durable Object class, a queue name —
  // fall back to that product's list page: one click from the resource, and never a fabricated deep link.
  const url =
    accountId && provisioned
      ? ((target ? dashboardUrl(kind, accountId, target) : null) ?? dashboardListUrl(kind, accountId))
      : null;
  return { kind, binding: binding ?? "", id, provisioned, dashboardUrl: url };
}

/** Every binding declared in a stanza, in a stable kind order. */
function collectResources(stanza: RawStanza, accountId: string | null): EnvResource[] {
  const resources: EnvResource[] = [];
  for (const entry of stanza.d1_databases ?? [])
    resources.push(makeResource("d1", entry.binding, entry.database_id, accountId));
  for (const entry of stanza.kv_namespaces ?? [])
    resources.push(makeResource("kv", entry.binding, entry.id, accountId));
  for (const entry of stanza.r2_buckets ?? [])
    resources.push(makeResource("r2", entry.binding, entry.bucket_name, accountId));
  // A DO binding names a **class**; the dashboard addresses a DO by the namespace id Cloudflare
  // assigns, which `wrangler.jsonc` never carries. So the class name is shown and no link is built
  // — resolving the namespace id would take a Cloudflare API call this read-only command does not make.
  for (const entry of stanza.durable_objects?.bindings ?? [])
    resources.push(makeResource("durable_object", entry.name, entry.class_name, accountId, null));
  return resources;
}

/**
 * The base URL for an environment, through the one resolver.
 *
 * `dev` keeps its `"local"` sentinel — there is no public address for a local run, and the real answer
 * is `http://localhost:<port>` from the port pinned in `.dev.config.json`, which is not this report's
 * business. For every other environment `resolveWorkerAddress` decides, in its documented order:
 * the `domains` declaration, then the first route, then a hand-set `vars.BASE_URL`.
 *
 * The resolver is **offline by construction**, which is what lets it be used here: `pithy env` is
 * contractually read-only and always exits 0, so a resolver that reached Cloudflare would turn it into a
 * command that fails without credentials.
 */
function deriveBaseUrl(name: string, stanza: RawStanza, domains: WorkerDomains | undefined): string | null {
  if (name === "dev") return "local";
  return resolveWorkerAddress({ environment: name, domains, stanza })?.url ?? null;
}

/** Assemble one environment report from its stanza. */
function buildEnvironment(
  name: string,
  stanza: RawStanza,
  scriptName: string | null,
  accountId: string | null,
  domains: WorkerDomains | undefined,
): EnvironmentReport {
  const workerDashboardUrl = accountId && scriptName ? dashboardUrl("worker", accountId, scriptName) : null;
  return {
    name,
    scriptName,
    baseUrl: deriveBaseUrl(name, stanza, domains),
    workerDashboardUrl,
    resources: collectResources(stanza, accountId),
  };
}

/** Every environment one Worker declares: the top-level stanza as `dev`, then each `env.<name>`. */
function buildEnvironments(
  config: RawWrangler,
  accountId: string | null,
  domains: WorkerDomains | undefined,
): EnvironmentReport[] {
  const environments: EnvironmentReport[] = [buildEnvironment("dev", config, config.name ?? null, accountId, domains)];
  for (const [name, stanza] of Object.entries(config.env ?? {})) {
    if (!stanza) continue;
    environments.push(buildEnvironment(name, stanza, stanza.name ?? null, accountId, domains));
  }
  return environments;
}

/** Options for {@link buildEnvInventory}. */
export interface EnvInventoryOptions {
  /** The project root — the parent of `apps/`. */
  projectDir: string;
  /** Inventory only this Worker, by the name `pithy worker list` shows or its `apps/<dir>` basename. */
  worker?: string;
  /** Discovery seam (default: `discoverWorkers`), so tests need no `apps/` tree on disk. */
  discoverWorkers?: (projectDir: string) => Promise<WorkerTarget[]>;
  /** Where the Pithy config directory is. Defaults to the real one; a seam so a test reads its own. */
  paths?: StatePathOptions;
}

/**
 * Build the environment inventory for a project: every Worker under `apps/`, each read from its own
 * `wrangler.jsonc`, plus the Cloudflare account id from `<config>/cloudflare.json`/the environment. A project with no
 * Worker at all is a clean `NotFoundError`; a missing account id is not — the inventory still prints,
 * only without dashboard links. `worker` narrows the report to one Worker.
 */
export async function buildEnvInventory(options: EnvInventoryOptions): Promise<EnvInventory> {
  const discover = options.discoverWorkers ?? discoverWorkersDefault;
  const targets = (await discover(options.projectDir)).filter((target) => target.hasWrangler !== false);
  if (targets.length === 0) {
    throw new NotFoundError({
      message: "No workers here.",
      action: "Every worker lives in apps/<name> with its own wrangler.jsonc. Run pithy init to start a project.",
    });
  }

  const selected =
    options.worker === undefined
      ? targets
      : targets.filter((target) => target.name === options.worker || target.dir.endsWith(`/${options.worker}`));
  if (selected.length === 0) {
    throw new NotFoundError({
      message: `No worker named "${options.worker}".`,
      action: `Run pithy worker list to see this project's workers. Known: ${targets.map((t) => t.name).join(", ")}.`,
    });
  }

  const accountId = cloudflareEnv(options.paths ?? {}).CLOUDFLARE_ACCOUNT_ID ?? null;

  const workers: WorkerEnvironments[] = [];
  for (const target of selected) {
    let config: RawWrangler;
    try {
      config = (await readWranglerConfig(target.dir)) as RawWrangler;
    } catch (error) {
      // Discovery said this Worker had a wrangler.jsonc; it vanished or is unreadable mid-run. `pithy env`
      // reports, it does not gate — carry on with the other Workers rather than failing the whole inventory.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // The declaration, when this Worker has one. Read defensively: `pithy env` reports and does not
    // gate, so a Worker whose `pithy.config.ts` is missing, unimportable, or carries a malformed
    // `domains` block must still have its wrangler-derived environments listed rather than fail the
    // whole inventory. The declaration simply does not contribute for that Worker, and the route
    // fallback answers instead.
    let domains: WorkerDomains | undefined;
    try {
      domains = loadWorkerDomains(await loadWorkerConfig(target.dir));
    } catch {
      domains = undefined;
    }

    workers.push({
      worker: target.name,
      dir: relative(options.projectDir, target.dir),
      environments: buildEnvironments(config, accountId, domains),
    });
  }

  return EnvInventory.parse({ accountId, workers });
}
