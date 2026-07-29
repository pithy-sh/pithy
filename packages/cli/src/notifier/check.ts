import { detectInstaller } from "./installer";
import type { NotifierState } from "./state";

/**
 * The background update check (docs/CLI.md §5.1): a 24-hour-gated query of the npm registry for the latest
 * `@pithy-sh/cli` version, plus the per-capability version lookups `pithy doctor` runs. Every network path
 * is silent on failure — offline, DNS, a non-200, or a timeout all leave the cached value in place and
 * never surface an error. Update checks are non-essential; they must never break the actual CLI.
 */

/** A minimal `fetch` shape — the real `globalThis.fetch` satisfies it, and tests inject a fake. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponse>;

/** The slice of a `fetch` `Response` the notifier reads. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** The npm scope every Pithy package ships under. */
const SCOPE = "@pithy-sh";
/** How long a stale check waits before giving up on the registry, so a hung request never delays exit. */
const DEFAULT_TIMEOUT_MS = 3_000;
/** The cache window: at most one background check per 24 hours. */
export const CACHE_MS = 24 * 60 * 60 * 1000;

/** The registry `latest`-manifest URL for an unscoped `@pithy-sh/<name>` package (matches docs/CLI.md §5.1). */
export function registryUrl(unscopedName: string): string {
  return `https://registry.npmjs.org/${SCOPE}%2F${unscopedName}/latest`;
}

/** The latest published version of a package, plus whether the release is security-flagged. */
export interface LatestInfo {
  version: string;
  securityFlagged: boolean;
}

/** Read the `pithy:security` marker off a registry manifest: a top-level flag or a nested `pithy.security`. */
function readSecurityFlag(manifest: Record<string, unknown>): boolean {
  if (manifest["pithy:security"] === true) return true;
  const pithy = manifest.pithy;
  return typeof pithy === "object" && pithy !== null && (pithy as { security?: unknown }).security === true;
}

/**
 * Query the registry for a package's latest version. Returns `null` on any failure — a rejected fetch, a
 * non-200, a timeout, or an unparseable body — so callers keep using their cached value. A short timeout
 * bounds a hung registry. The security flag defaults to not-flagged when it can't be determined.
 */
export async function fetchLatestVersion(
  unscopedName: string,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<LatestInfo | null> {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // Don't let the abort timer itself hold the event loop open — the update check must never delay the CLI's
  // exit past its own work. (Node timers expose unref; guard for non-Node timers.)
  timer.unref?.();
  try {
    const response = await doFetch(registryUrl(unscopedName), { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const version = body.version;
    if (typeof version !== "string") return null;
    return { version, securityFlagged: readSecurityFlag(body) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Options for {@link refreshCliState} — the version-check inputs, all injectable for deterministic tests. */
export interface RefreshOptions {
  /** Injected `fetch`; defaults to the global. */
  fetch?: FetchLike;
  /** The clock; defaults to `Date.now`. */
  now?: () => number;
  /** Bypass the 24-hour cache and always query (what `pithy doctor` passes). */
  bypassCache?: boolean;
  /** The cache window in ms; defaults to 24 hours. */
  cacheMs?: number;
  /** `process.argv[1]`, used to detect the installer once when it is still `unknown`. */
  argv1?: string;
  /** Registry request timeout in ms. */
  timeoutMs?: number;
}

/** The outcome of a refresh: the (possibly-updated) state and whether a successful network check changed it. */
export interface RefreshResult {
  state: NotifierState;
  /** True only when a network query succeeded and updated the state — the signal to persist it. */
  updated: boolean;
}

/**
 * Apply the 24-hour cache gate to the CLI version check and, when due, refresh the state from the registry.
 *
 * - Within the cache window (and not bypassing): no network request; the cached state is returned unchanged.
 * - Stale (or bypassing): one registry query. On success, `lastCheck`, `latestVersion`, `securityFlagged`,
 *   and — if still `unknown` — `installer` are updated, and `updated` is true (persist it).
 * - On any network failure: the cached state is returned unchanged with `updated` false, so no partial
 *   state is ever written and the previously-known `latestVersion` continues to drive the notification.
 */
export async function refreshCliState(state: NotifierState, options: RefreshOptions = {}): Promise<RefreshResult> {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? CACHE_MS;
  const fresh = now() - state.lastCheck < cacheMs;
  if (fresh && !options.bypassCache) return { state, updated: false };

  const latest = await fetchLatestVersion("cli", { fetch: options.fetch, timeoutMs: options.timeoutMs });
  if (!latest) return { state, updated: false };

  return {
    state: {
      ...state,
      lastCheck: now(),
      latestVersion: latest.version,
      securityFlagged: latest.securityFlagged,
      installer: state.installer === "unknown" ? detectInstaller(options.argv1) : state.installer,
    },
    updated: true,
  };
}
