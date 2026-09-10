// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretsStoreEnv } from "./env/bindings";
import type { SecretRegistry, SecretRegistryEntry } from "./registry";
import { d1KeyedIO, type SecretsAccessor, secretsStore } from "./secretsStore";

/**
 * The shared, per-invocation secrets accessor. Within one worker invocation many capabilities each
 * read secrets; resolving them independently means a Secrets Store round-trip per call site, and a
 * repeated round-trip when two capabilities share a secret. This module resolves the **combined**
 * registry — every capability's {@link Capability.secretRegistry} slice merged into one — exactly
 * once, caches the resulting accessor for a configurable TTL (default 60 s), and hands each call site
 * a precisely-typed view over only its own slice via {@link SecretsAccessor.subset}.
 *
 * Sharing one resolution is what made #170 bite: the combined registry is every capability's, so an
 * unset secret anywhere in it used to fail the one resolution every capability waits on. The fix is in
 * {@link secretsStore} — a failure is held against its own name and raised at its own read — and it is
 * the reason a shared accessor is safe to share. This module resolves once; it does not resolve
 * all-or-nothing.
 *
 * The cache is module-scoped, so it is per worker isolate: built lazily on the first request that
 * needs secrets, reused by every access within the TTL, and rebuilt on the first access after it
 * expires. `@pithy-sh/secrets`' capability {@link configureSharedSecrets | configures} the combined
 * registry and TTL at worker startup (via its `compose` hook); a standalone worker that uses the
 * accessor without `createBackend` (the email and secrets-manager workers) configures it directly.
 */

/** Default cache lifetime when the secrets capability does not override it. */
export const DEFAULT_SECRETS_CACHE_TTL_SECONDS = 60;

/**
 * The longest cache lifetime this accessor accepts — an hour, and it refuses above rather than clamping.
 *
 * The ceiling exists because `Number.isFinite` is not the whole of the failure it guards. `Infinity` is the
 * loud version of *this cache never expires*; `3_600_000` — an hour written in the milliseconds this option
 * is not measured in — is the quiet version, and it pins a secret for longer than any isolate lives, which
 * makes the two indistinguishable in production. A rotation's overlap window is what a cache lifetime has to
 * fit inside: past it, `secretsStore` keeps handing out a value the rotation has already retired, and every
 * read that would have noticed is served from memory instead.
 *
 * An hour is chosen against the shortest overlap the rotator supports rather than against the 60-second
 * default, so an adopter who genuinely wants a long-lived cache has room and an adopter who typed the wrong
 * unit does not. Refused rather than clamped, on the same argument as every other bound here: clamped, the
 * worker runs and nobody reads the line again.
 */
export const MAX_SECRETS_CACHE_TTL_SECONDS = 3600;

/** Resolves the combined registry against `env` — the real path calls {@link secretsStore}; tests inject a fake. */
type Resolver = (env: SecretsStoreEnv, registry: SecretRegistry) => Promise<SecretsAccessor<SecretRegistry>>;

/** A monotonic millisecond clock — `Date.now` in production, controllable in tests. */
type Clock = () => number;

/** Options for {@link configureSharedSecrets}. `resolve`/`now` are seams overridden only by tests. */
export interface ConfigureSharedSecretsOptions {
  /** The combined registry to resolve — every capability's slice merged. */
  registry: SecretRegistry;
  /**
   * Cache lifetime in seconds. Defaults to {@link DEFAULT_SECRETS_CACHE_TTL_SECONDS}, and must be a finite
   * number from 0 to {@link MAX_SECRETS_CACHE_TTL_SECONDS} — anything else is `core/internal`, because it
   * decides when a rotated-out secret stops being served.
   */
  ttlSeconds?: number;
  /** Override the resolver (testing). Defaults to a real {@link secretsStore} call. */
  resolve?: Resolver;
  /** Override the clock (testing). Defaults to `Date.now`. */
  now?: Clock;
}

interface SharedConfig {
  registry: SecretRegistry;
  ttlMs: number;
  resolve: Resolver;
  now: Clock;
}

interface CacheEntry {
  accessor: SecretsAccessor<SecretRegistry>;
  expiresAt: number;
}

let config: SharedConfig | null = null;
let cache: CacheEntry | null = null;
let inflight: Promise<SecretsAccessor<SecretRegistry>> | null = null;

/**
 * Configure the shared accessor with the combined registry and TTL. Called once at worker startup
 * (the secrets capability's `compose` hook, or a standalone worker's module scope). Resets any
 * cached accessor so the next access re-resolves against the new configuration.
 */
export function configureSharedSecrets(options: ConfigureSharedSecretsOptions): void {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_SECRETS_CACHE_TTL_SECONDS;
  // The direction here is inverted from the usual non-finite fail-open, and that is the reason the check is
  // `Number.isFinite` and not a `NaN` test. `Infinity` makes `expiresAt` infinite, `now < Infinity` is true
  // forever, and the process-global cache never expires — so a secret that has since been rotated out keeps
  // being served for the life of the isolate. That is a key pin nobody chose, not a fast cache. `NaN` and a
  // negative both fail *closed* (they expire immediately and cost a round-trip), which is exactly why a check
  // that only looked for `NaN` would miss the one value that matters. `secretsCacheTtlSeconds` reaches here
  // from `SecretsConfig`, which is a plain TypeScript interface and the one capability config in the kit that
  // is not Zod-parsed at boot — so there is no `.parse()` upstream doing this for us.
  //
  // The upper bound is the third clause and not an optional flourish: `Infinity` and a large finite number are
  // the same defect with different volume — see {@link MAX_SECRETS_CACHE_TTL_SECONDS}. Checking finiteness
  // alone catches the spelling nobody writes and misses the one somebody does.
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > MAX_SECRETS_CACHE_TTL_SECONDS) {
    throw new InternalError({
      message: "The shared secrets accessor is not configured.",
      action: `Set \`secretsCacheTtlSeconds\` to a finite number of seconds, from 0 to ${MAX_SECRETS_CACHE_TTL_SECONDS}.`,
      detail: `configureSharedSecrets was given a cache lifetime of ${String(ttlSeconds)} seconds; a non-finite or over-long one never expires in practice, which pins a secret past its rotation.`,
    });
  }
  config = {
    registry: options.registry,
    ttlMs: ttlSeconds * 1000,
    resolve: options.resolve ?? ((env, registry) => secretsStore(env, registry)),
    now: options.now ?? Date.now,
  };
  cache = null;
  inflight = null;
}

/** Clear all shared state — configuration and cache. For test isolation between cases. */
export function resetSharedSecrets(): void {
  config = null;
  cache = null;
  inflight = null;
}

function requireConfig(): SharedConfig {
  if (!config) {
    throw new InternalError({
      message: "The shared secrets accessor is not configured.",
      detail: "configureSharedSecrets was never called — compose the `secrets` capability, or configure it directly.",
    });
  }
  return config;
}

/** Resolve the combined accessor, honoring the TTL cache and de-duplicating a concurrent first fetch. */
async function resolveCombined(env: SecretsStoreEnv): Promise<SecretsAccessor<SecretRegistry>> {
  const cfg = requireConfig();
  if (cache && cfg.now() < cache.expiresAt) return cache.accessor;
  // A concurrent access during the fetch shares the one in-flight resolution, so the combined
  // registry is fetched once even when several capabilities read secrets in the same invocation.
  if (inflight) return inflight;
  inflight = cfg
    .resolve(env, cfg.registry)
    .then((accessor) => {
      cache = { accessor, expiresAt: cfg.now() + cfg.ttlMs };
      return accessor;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * The shared, per-invocation accessor for `registry` — the calling capability's own slice. Resolves
 * the combined registry once (cached for the TTL) and returns a precisely-typed view over `registry`.
 * Every name in `registry` must be part of the configured combined registry; a name that is not is a
 * wiring bug (the capability did not declare its slice on `secretRegistry`) and throws at the call.
 */
export async function sharedSecretsStore<R extends SecretRegistry>(
  env: SecretsStoreEnv,
  registry: R,
): Promise<SecretsAccessor<R>> {
  const cfg = requireConfig();
  for (const name of Object.keys(registry)) {
    if (!(name in cfg.registry)) {
      throw new InternalError({
        message: `Secret "${name}" is not in the aggregated registry.`,
        detail: `'${name}' was requested but no capability declared it on its secretRegistry slice`,
        action: "Declare the secret on the reading capability's `secretRegistry`.",
      });
    }
  }
  const combined = await resolveCombined(env);
  // The combined accessor is cached across requests; a keyspace read or write is not cached at all,
  // and runs real I/O. Bind it to *this* invocation's env so a member is never fetched — or sealed —
  // through the binding of whichever earlier request happened to fill the cache.
  return combined.subset(registry, d1KeyedIO(env));
}

/**
 * Merge every capability's {@link Capability.secretRegistry} slice into one combined registry — the
 * source of truth the shared accessor resolves. A secret name declared by more than one capability is
 * allowed only when the declarations agree on every axis (`backend`, `scope`, `valueType`,
 * `rotatable`, `keyed`); a divergent re-declaration is an author conflict and throws. The `secretsStore`
 * reader keys purely on the name, so identical re-declarations resolve the same stored value.
 */
export function aggregateSecretRegistries(capabilities: readonly Capability[]): SecretRegistry {
  const combined: Record<string, SecretRegistryEntry> = {};
  const owners: Record<string, string> = {};
  for (const cap of capabilities) {
    // The Capability contract carries the slice as the loose `SecretRegistrySeam`; the concrete
    // entries are always built by `defineSecretRegistry`, so this narrowing is sound at the seam.
    const slice = cap.secretRegistry as SecretRegistry | undefined;
    if (!slice) continue;
    for (const [name, entry] of Object.entries(slice)) {
      const existing = combined[name];
      if (existing) {
        if (
          existing.backend !== entry.backend ||
          existing.scope !== entry.scope ||
          existing.valueType !== entry.valueType ||
          existing.rotatable !== entry.rotatable ||
          // A keyspace and a name are not the same secret, whatever else agrees: one resolves
          // `<name>/<key>`, the other `<name>`.
          Boolean(existing.keyed) !== Boolean(entry.keyed)
        ) {
          throw new InternalError({
            message: `Secret "${name}" is declared incompatibly by capabilities "${owners[name]}" and "${cap.name}".`,
            action: "Declare the same backend, scope, valueType, rotatable, and keyed for a shared secret name.",
          });
        }
        continue;
      }
      combined[name] = entry;
      owners[name] = cap.name;
    }
  }
  return combined;
}
