// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { isPermissionKey, PERMISSION_GROUPS, type PermissionKey } from "@pithy-sh/cloudflare/src/tokens/permissions";
import { resolveTokenProfiles, TOKEN_STORES, type TokenStore } from "@pithy-sh/cloudflare/src/tokens/profiles";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { defineCommand } from "citty";
import { createCliAudit } from "../audit/cliAudit";
import { resolveSecretRegistry } from "../capabilities/secrets";
import { loadProject, requireProjectName } from "../project/config";
import { ENV_ARG, requireEnvironment } from "../project/environment";
import { projectCapabilities, type ResolvedWorker, resolveWorkers } from "../project/workerScope";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";
import { tokenOverrideResolver } from "../tokens/config";
import {
  listProfileTokens,
  mintProfileToken,
  revokeProfileToken,
  rotateProfileToken,
  type TokenAudit,
  type TokenEngine,
  type TokenResult,
} from "../tokens/engine";

// `resolveAppDatabaseId` used to be this file's own copy of the app-database lookup, before
// `createCliAudit` centralized it. Re-exported under its original name — same behavior, same
// signature — so `token.test.ts`'s direct tests of it keep passing unchanged.
export { resolveAuditDatabaseId as resolveAppDatabaseId } from "../audit/cliAudit";

/** The CF credentials the token engine needs, from `.dev.vars` then `process.env`. */
function loadCreds(projectDir: string): { accountId: string; apiToken: string; storeId: string } {
  const vars = loadCloudflareEnv(projectDir);
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) {
    throw new ValidationError({
      message: "Cloudflare credentials are missing.",
      action: "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (the bootstrap token) to mint tokens.",
    });
  }
  return { accountId, apiToken, storeId: vars.SECRETS_STORE_ID ?? "" };
}

/**
 * Collect every `--permission` from the raw argv. citty keeps only the last occurrence of a repeated
 * string flag, so a multi-permission run would otherwise silently drop all but the last — the same
 * reason `--set` is read from rawArgs. Handles both `--permission key` and `--permission=key`.
 */
export function collectPermissionFlags(rawArgs: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--permission") {
      const value = rawArgs[i + 1];
      if (value !== undefined) {
        found.push(value);
        i++;
      }
    } else if (arg?.startsWith("--permission=")) {
      found.push(arg.slice("--permission=".length));
    }
  }
  return found;
}

/** Validate collected `--permission` keys, or `undefined` when none were given. */
export function parsePermissions(value: string | string[] | undefined): PermissionKey[] | undefined {
  const keys = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (keys.length === 0) return undefined;
  for (const key of keys) {
    if (!isPermissionKey(key)) {
      throw new ValidationError({
        message: `Unknown token permission key: ${key}.`,
        action: `Use one of: ${Object.keys(PERMISSION_GROUPS).join(", ")}.`,
      });
    }
  }
  return keys as PermissionKey[];
}

/** Parse a `--store` flag into a validated store, or `undefined` when absent. */
export function parseStore(value: string | undefined): TokenStore | undefined {
  if (value === undefined) return undefined;
  if (!(TOKEN_STORES as readonly string[]).includes(value)) {
    throw new ValidationError({
      message: `Unknown token store: ${value}.`,
      action: `Use one of: ${TOKEN_STORES.join(", ")}.`,
    });
  }
  return value as TokenStore;
}

/** Project a mint/rotate result to the safe fields for output — everything except the secret `value`. */
export function publicToken(result: TokenResult): {
  profile: string;
  env: string;
  tokenId: string;
  store: TokenStore;
  location: string;
} {
  return {
    profile: result.profile,
    env: result.env,
    tokenId: result.tokenId,
    store: result.sink.sink,
    location: result.sink.location,
  };
}

/**
 * Build the token engine's audit sink from the shared `createCliAudit` helper — the one place every
 * CLI command resolves whether/where to record. `createCliAudit` already handles every reason there
 * might be nowhere to write (audit not composed, package not installed, no app database for the env)
 * by returning an always-callable no-op, so `TokenAudit` here is just a thin adapter from its event
 * shape to the generic `CliAuditEvent` — never the token value, only its id and where it went.
 */
async function buildAudit(
  capabilities: readonly Capability[],
  cf: CloudflareClients,
  projectDir: string,
  env: string,
  apiToken: string,
): Promise<TokenAudit> {
  const emit = await createCliAudit({ projectDir, env, capabilities, clients: cf, apiToken });
  return async (event) => {
    await emit({
      action: event.action,
      outcome: event.outcome,
      severity: "warning",
      resourceType: "cf_api_token",
      resourceId: event.tokenId ?? `${event.profile}:${event.env}`,
      metadata: { profile: event.profile, env: event.env, store: event.store ?? null },
    });
  };
}

/**
 * Every secret backend declared anywhere in the project, merged by name. The name is the join key, so a
 * Worker that composes `secrets` contributes its registry and one that does not contributes nothing —
 * a project with no secrets capability at all resolves to `{}` rather than failing a mint.
 */
function mergedSecretRegistry(workers: readonly ResolvedWorker[]): SecretRegistry {
  const registries: SecretRegistry[] = [];
  for (const worker of workers) {
    try {
      registries.push(resolveSecretRegistry(worker.config));
    } catch {
      // This Worker composes no secrets capability — nothing to contribute.
    }
  }
  return Object.assign({}, ...registries) as SecretRegistry;
}

/** Assemble the token engine: the aggregated profiles, the secret-registry backends, and the audit sink. */
async function buildEngine(projectDir: string, env: string): Promise<TokenEngine> {
  const { accountId, apiToken, storeId } = loadCreds(projectDir);
  const cf = new CloudflareClients({ accountId, apiToken });
  // Identity/policy comes from the root config; what the project is *made of* comes from each Worker's.
  // The root config is required here, not best-effort: every token name and Secrets Store entry starts
  // with the project name, and `revoke` deletes every account token of the name it computes. Guessing
  // it would point that sweep at another project's credentials.
  const config = await loadProject(projectDir);
  const workers = await resolveWorkers({ projectDir }).catch(() => []);
  const capabilities = projectCapabilities(workers);
  const registry = mergedSecretRegistry(workers);
  return {
    accountId,
    project: requireProjectName(config),
    projectDir,
    tokens: cf.accountTokens(),
    profiles: resolveTokenProfiles(capabilities),
    secretBackend: (name) => registry[name]?.backend,
    putSecret: storeId ? (name, value) => cf.secrets(storeId).putSecret(name, value) : undefined,
    audit: await buildAudit(capabilities, cf, projectDir, env, apiToken),
    override: tokenOverrideResolver(config),
  };
}

const profileArg = {
  profile: {
    type: "positional",
    required: true,
    description: "Token profile: ci-system (the CI credential), or a capability's worker-consumer profile",
  },
} as const;
const envArgs = { env: ENV_ARG } as const;
const jsonArg = { json: { type: "boolean", default: false, description: "Machine-readable output" } } as const;
const overrideArgs = {
  store: { type: "string", description: `Override where the value is written: ${TOKEN_STORES.join(" | ")}` },
  permission: {
    type: "string",
    description: `Override permissions (repeatable): ${Object.keys(PERMISSION_GROUPS).join(", ")}`,
  },
} as const;

const mint = defineCommand({
  meta: { name: "mint", description: "Mint a scoped account token for a profile (rolls to the current scope)" },
  args: { ...profileArg, ...envArgs, ...overrideArgs, ...jsonArg },
  run: ({ args, rawArgs }) =>
    withErrorReporting(args.json, async () => {
      const env = requireEnvironment(args.env);
      const engine = await buildEngine(process.cwd(), env);
      const result = await mintProfileToken(engine, args.profile, env, {
        store: parseStore(args.store),
        permissions: parsePermissions(collectPermissionFlags(rawArgs)),
      });
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "token mint", ...publicToken(result) })}\n`);
        return;
      }
      process.stdout.write(`${result.profile}: minted → ${result.sink.location}.\n`);
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const list = defineCommand({
  meta: { name: "list", description: "List minted tokens for an environment (ids and profiles, never values)" },
  args: { ...envArgs, ...jsonArg },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const env = requireEnvironment(args.env);
      const engine = await buildEngine(process.cwd(), env);
      const tokens = await listProfileTokens(engine, env);
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "token list", env, tokens })}\n`);
        return;
      }
      if (tokens.length === 0) {
        process.stdout.write(`No minted tokens for ${env}.\n`);
        return;
      }
      process.stdout.write(
        `${formatList(tokens.map((token) => ({ name: token.profile, description: `${token.tokenId}${token.status ? ` · ${token.status}` : ""}` })))}\n`,
      );
    }),
});

const rotate = defineCommand({
  meta: { name: "rotate", description: "Rotate a profile's token (create new, delete old)" },
  args: {
    ...profileArg,
    ...envArgs,
    ...overrideArgs,
    "keep-previous": { type: "boolean", default: false, description: "Keep the old token as a grace window" },
    ...jsonArg,
  },
  run: ({ args, rawArgs }) =>
    withErrorReporting(args.json, async () => {
      const env = requireEnvironment(args.env);
      const engine = await buildEngine(process.cwd(), env);
      const result = await rotateProfileToken(engine, args.profile, env, {
        store: parseStore(args.store),
        permissions: parsePermissions(collectPermissionFlags(rawArgs)),
        keepPrevious: args["keep-previous"],
      });
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "token rotate", ...publicToken(result) })}\n`);
        return;
      }
      process.stdout.write(`${result.profile}: rotated → ${result.sink.location}.\n`);
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const revoke = defineCommand({
  meta: { name: "revoke", description: "Revoke a profile's token for an environment" },
  args: { ...profileArg, ...envArgs, ...jsonArg },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const env = requireEnvironment(args.env);
      const engine = await buildEngine(process.cwd(), env);
      const result = await revokeProfileToken(engine, args.profile, env);
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "token revoke", ...result })}\n`);
        return;
      }
      process.stdout.write(`${result.profile}: revoked ${result.revoked} token${result.revoked === 1 ? "" : "s"}.\n`);
      process.stdout.write(`${formatDone()}\n`);
    }),
});

export default defineCommand({
  meta: { name: "token", description: "Mint and manage scoped Cloudflare API tokens" },
  subCommands: { mint, list, rotate, revoke },
});
