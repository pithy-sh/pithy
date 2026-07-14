import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { messageOf, NotFoundError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { red } from "../terminal/style";
import { discoverWorkers, type WorkerTarget } from "./workers";
import { runWrangler } from "./wrangler";

/** The `wrangler deploy` runner for one worker — injectable so tests exercise orchestration without wrangler. */
export type RunDeploy = (target: WorkerTarget, args: string[]) => Promise<string>;

export interface DeployProjectOptions {
  /** The project root — where `apps/*` (or the single root worker) live. */
  projectDir: string;
  /** Target environment; omitted deploys the top-level worker (no `--env`). */
  env?: string;
  /** Test seam: run one worker's deploy and return its captured stdout. Defaults to real wrangler. */
  runDeploy?: RunDeploy;
}

/** One worker's deploy outcome — the `--json` row and the human summary line both read from this. */
export interface WorkerDeploy {
  /** The worker's name. */
  name: string;
  /** Whether `wrangler deploy` succeeded for this worker. */
  ok: boolean;
  /** The deployed version id, when wrangler's output carried one. */
  versionId?: string;
  /** The worker's public URL, when wrangler's output carried one. */
  url?: string;
  /** The failure reason, present only when `ok` is false. */
  error?: string;
}

/** Scrape the version id and public url from `wrangler deploy` output — best-effort, both optional. */
function parseDeployOutput(stdout: string): { versionId?: string; url?: string } {
  const summary: { versionId?: string; url?: string } = {};
  const version = stdout.match(/Version ID:\s*(\S+)/);
  if (version) summary.versionId = version[1];
  // The deployed URL is the last one wrangler prints (after upload), not an earlier docs/dashboard link.
  const urls = stdout.match(/https?:\/\/\S+/g);
  if (urls) summary.url = urls[urls.length - 1];
  return summary;
}

/**
 * The failure reason for a thrown deploy. For a `PithyError` (how `runWrangler` reports a non-zero
 * exit) that means the `detail` — wrangler's captured exit code and stderr, the part a CI operator
 * needs — not just the generic public `message`. Anything else falls back to the shared `messageOf`.
 */
function reasonOf(error: unknown): string {
  if (error instanceof PithyError) return error.payload.detail ?? error.payload.message;
  return messageOf(error);
}

/**
 * The default deploy step: `wrangler deploy [--env <env>]` in the worker's directory, quiet on
 * success (its output is captured and summarized, not streamed — the brand voice). Wrangler reads
 * `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, so CI needs no interactive login; we also pass them
 * from `.dev.vars` so a local deploy authenticates the same way.
 */
function defaultRunDeploy(projectDir: string): RunDeploy {
  const vars = loadCloudflareEnv(projectDir);
  const env: Record<string, string> = {};
  if (vars.CLOUDFLARE_API_TOKEN) env.CLOUDFLARE_API_TOKEN = vars.CLOUDFLARE_API_TOKEN;
  if (vars.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = vars.CLOUDFLARE_ACCOUNT_ID;
  return async (target, args) => {
    const { stdout } = await runWrangler(args, { cwd: target.dir, env });
    return stdout;
  };
}

/**
 * Deploy the project's Workers — the logic behind `pithy deploy`. It enumerates the worker registry
 * (`apps/*`, or the single root worker) and runs `wrangler deploy` per worker, letting wrangler own
 * bundling, upload, bindings, and routes. One worker's failure does not abort the batch: every worker
 * is attempted and reported, so the caller can exit non-zero if any `ok` is false.
 */
export async function deployProject(options: DeployProjectOptions): Promise<WorkerDeploy[]> {
  const workers = await discoverWorkers(options.projectDir);
  if (workers.length === 0) {
    throw new NotFoundError({
      message: "No deployable workers here.",
      action: "Add a worker under apps/, or run from a project with a wrangler.jsonc.",
    });
  }

  const run = options.runDeploy ?? defaultRunDeploy(options.projectDir);
  const args = options.env ? ["deploy", "--env", options.env] : ["deploy"];

  const deploys: WorkerDeploy[] = [];
  for (const worker of workers) {
    try {
      const stdout = await run(worker, args);
      deploys.push({ name: worker.name, ok: true, ...parseDeployOutput(stdout) });
    } catch (error) {
      deploys.push({ name: worker.name, ok: false, error: reasonOf(error) });
    }
  }
  return deploys;
}

/** One worker's human summary line — brand voice; red on failure, url + version id on success. */
export function summarizeDeploy(deploy: WorkerDeploy): string {
  if (!deploy.ok) return red(`${deploy.name}: failed.`) + (deploy.error ? ` ${deploy.error}` : "");
  const detail = [deploy.url, deploy.versionId].filter(Boolean).join(" ");
  return detail ? `${deploy.name}: deployed. ${detail}` : `${deploy.name}: deployed.`;
}

/**
 * The warn line when the target env's schema is behind — deploy never migrates, so it only surfaces
 * the drift and points at `pithy migrate`. `undefined` when nothing is pending or the count is unknown.
 */
export function pendingWarning(pending: number | undefined, env: string): string | undefined {
  if (!pending || pending <= 0) return undefined;
  const plural = pending === 1 ? "" : "s";
  return `${pending} migration${plural} unapplied for ${env}. Deploy does not migrate — run pithy migrate --env ${env}.`;
}
