import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { isPermissionKey, PERMISSION_GROUPS, type PermissionKey } from "@pithy-sh/cloudflare/src/tokens/permissions";
import { resolveTokenProfiles, TOKEN_STORES, type TokenStore } from "@pithy-sh/cloudflare/src/tokens/profiles";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { parse } from "comment-json";
import { resolveSecretRegistry } from "../capabilities/secrets";
import { allCapabilities, loadProject, type ProjectConfig } from "../project/config";
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

/** The wrangler.jsonc slice token audit reads: the app `DB` id, per environment (dev is top-level). */
interface WranglerAppConfig {
  d1_databases?: { binding: string; database_id?: string }[];
  env?: Record<string, { d1_databases?: { binding: string; database_id?: string }[] } | undefined>;
}

/** The app database id for an env from `wrangler.jsonc` (binding `DB`), or `undefined` — the audit target. */
export async function resolveAppDatabaseId(projectDir: string, env: string): Promise<string | undefined> {
  try {
    const config = parse(await readFile(join(projectDir, "wrangler.jsonc"), "utf8")) as unknown as WranglerAppConfig;
    const stanza = env === "dev" ? config : config.env?.[env];
    return stanza?.d1_databases?.find((database) => database.binding === "DB")?.database_id;
  } catch {
    return undefined;
  }
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
 * Build a best-effort audit sink — **only** when the project composes the audit capability, so the CLI
 * never hard-depends on `@pithy-sh/audit` (it stays optional). Audit's CLI recorder is loaded by
 * dynamic import, resolved from the project's own install; if audit isn't composed or can't load,
 * auditing is a no-op (the engine tolerates a missing sink). `emitFromCLI` is itself non-fatal.
 */
async function buildAudit(
  capabilities: readonly Capability[],
  cf: CloudflareClients,
  projectDir: string,
  env: string,
  apiToken: string,
): Promise<TokenAudit | undefined> {
  if (!capabilities.some((capability) => capability.name === "audit")) return undefined;
  const appDatabaseId = await resolveAppDatabaseId(projectDir, env);
  if (!appDatabaseId) return undefined;
  let emit: typeof import("@pithy-sh/audit/src/cli/emitFromCLI").emitFromCLI;
  let resolve: typeof import("@pithy-sh/audit/src/cli/resolveActor").resolveActor;
  try {
    ({ emitFromCLI: emit } = await import("@pithy-sh/audit/src/cli/emitFromCLI"));
    ({ resolveActor: resolve } = await import("@pithy-sh/audit/src/cli/resolveActor"));
  } catch {
    return undefined; // audit not installed in this project — nothing to record through.
  }
  const database = cf.d1(appDatabaseId) as unknown as D1Database;
  return async (event) => {
    const actor = await resolve(apiToken, cf.user());
    await emit(
      database,
      {
        action: event.action,
        outcome: event.outcome,
        severity: "warning",
        resourceType: "cf_api_token",
        resourceId: event.tokenId ?? `${event.profile}:${event.env}`,
        metadata: { profile: event.profile, env: event.env, store: event.store ?? null },
      },
      actor,
    );
  };
}

/** Assemble the token engine: the aggregated profiles, the secret-registry backends, and the audit sink. */
async function buildEngine(projectDir: string, env: string): Promise<TokenEngine> {
  const { accountId, apiToken, storeId } = loadCreds(projectDir);
  const cf = new CloudflareClients({ accountId, apiToken });
  const config: ProjectConfig | undefined = await loadProject(projectDir).catch(() => undefined);
  const capabilities = config ? allCapabilities(config) : [];
  const registry = config ? resolveSecretRegistry(config) : {};
  return {
    accountId,
    projectDir,
    tokens: cf.accountTokens(),
    profiles: resolveTokenProfiles(capabilities),
    secretBackend: (name) => registry[name]?.backend,
    putSecret: storeId ? (name, value) => cf.secrets(storeId).putSecret(name, value) : undefined,
    audit: await buildAudit(capabilities, cf, projectDir, env, apiToken),
    override: config ? tokenOverrideResolver(config) : undefined,
  };
}

const profileArg = {
  profile: {
    type: "positional",
    required: true,
    description: "Token profile: ci-system (the CI credential), or a capability's worker-consumer profile",
  },
} as const;
const envArg = { env: { type: "string", default: "dev", description: "Target environment" } } as const;
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
  args: { ...profileArg, ...envArg, ...overrideArgs, ...jsonArg },
  run: ({ args, rawArgs }) =>
    withErrorReporting(args.json, async () => {
      const engine = await buildEngine(process.cwd(), args.env);
      const result = await mintProfileToken(engine, args.profile, args.env, {
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
  args: { ...envArg, ...jsonArg },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const engine = await buildEngine(process.cwd(), args.env);
      const tokens = await listProfileTokens(engine, args.env);
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "token list", env: args.env, tokens })}\n`);
        return;
      }
      if (tokens.length === 0) {
        process.stdout.write(`No minted tokens for ${args.env}.\n`);
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
    ...envArg,
    ...overrideArgs,
    "keep-previous": { type: "boolean", default: false, description: "Keep the old token as a grace window" },
    ...jsonArg,
  },
  run: ({ args, rawArgs }) =>
    withErrorReporting(args.json, async () => {
      const engine = await buildEngine(process.cwd(), args.env);
      const result = await rotateProfileToken(engine, args.profile, args.env, {
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
  args: { ...profileArg, ...envArg, ...jsonArg },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const engine = await buildEngine(process.cwd(), args.env);
      const result = await revokeProfileToken(engine, args.profile, args.env);
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
