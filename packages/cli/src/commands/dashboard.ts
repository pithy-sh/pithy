// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import type { D1Database } from "@cloudflare/workers-types";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { Ed25519PublicJwk } from "@pithy-sh/core/src/controlPlane/data/connection";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { z } from "zod";
import { createCliAudit } from "../audit/cliAudit";
import { type CloudflareAccountSelection, resolveCloudflare } from "../cloudflare/config";
import { httpDashboardClient } from "../dashboard/api";
import {
  authorizeDashboard,
  type ConnectReport,
  connectDashboard,
  type DisconnectReport,
  dashboardStatus,
  disconnectDashboard,
  type OfflinePublicKey,
  type RotateReport,
  rotateDashboardKey,
  type StatusReport,
} from "../dashboard/connect";
import type { DashboardClient, DeviceAuthorization } from "../dashboard/contract";
import { defaultGrant, type GrantableScope, grantableScopes } from "../dashboard/grant";
import { type ConnectionRegistry, openConnectionRegistry } from "../dashboard/registry";
import { describeConnectTarget, resolveConnectTarget } from "../dashboard/resolveTarget";
import { loadProject, projectCloudflareAccount, requireProjectName } from "../project/config";
import { ENV_ARG, requireEnvironment } from "../project/environment";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
import { isProductionEnv } from "../seed/safety";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";

/**
 * `pithy dashboard` — connect a management client to an environment, rotate its key, revoke it, or
 * look at what is registered (docs/CONTROL-PLANE.md §15).
 *
 * **Connection is project-wide, per environment, never per Worker.** A Worker is only how the CLI
 * finds the app database; the row is keyed on `--env`.
 *
 * Every subcommand runs headlessly with `--json`, prompts only at a real terminal, and writes machine
 * output to stdout with diagnostics — the device code, the waiting line — on stderr, so a `--json`
 * consumer parses one clean line.
 *
 * The `format*Report` functions are exported and pure for the same reason `formatMigrateReport` is:
 * the output contract is what an operator and an agent both read, and it should be testable without a
 * project on disk.
 */

/** Where a human-facing pair list gets its label column. */
type Row = { name: string; description: string };

/** Render an aligned label/value block, or nothing when there is nothing to say. */
function block(rows: Row[]): string {
  return rows.length === 0 ? "" : `${formatList(rows)}\n`;
}

/**
 * Collect every `--scope` from the raw argv. citty keeps only the last occurrence of a repeated
 * string flag, so a multi-scope grant would otherwise silently narrow to one — the same reason
 * `--permission` and `--set` are read from `rawArgs`.
 */
export function collectScopeFlags(rawArgs: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--scope") {
      const value = rawArgs[i + 1];
      if (value !== undefined) {
        found.push(value);
        i++;
      }
    } else if (arg?.startsWith("--scope=")) {
      found.push(arg.slice("--scope=".length));
    }
  }
  return found;
}

/**
 * Read a JWK file's contents into the key half of an offline registration.
 *
 * The id comes from `--key-id`, else the file's own `kid`, and is required either way: it is what a
 * token's `kid` header names, and a key nobody can address is a key nobody can use. The JWK itself
 * goes through `Ed25519PublicJwk`, so a P-256 key or a private key with a `d` component is refused
 * here rather than written into the adopter's authorization row.
 */
export function parsePublicKey(raw: string, keyId: string | undefined): { keyId: string; publicKey: Ed25519PublicJwk } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    throw new ValidationError(
      {
        message: "That public key file isn't JSON.",
        action: 'Pass a JWK file: {"kty":"OKP","crv":"Ed25519","x":"…","kid":"…"}.',
      },
      { cause: error },
    );
  }

  const parsed = Ed25519PublicJwk.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError({
      message: "That key isn't an Ed25519 public JWK.",
      action: "The seam accepts Ed25519 only. Export the public half as a JWK and try again.",
      detail: z.prettifyError(parsed.error),
    });
  }

  const id = keyId ?? (typeof (body as { kid?: unknown }).kid === "string" ? (body as { kid: string }).kid : undefined);
  if (!id) {
    throw new ValidationError({
      message: "That key has no id.",
      action: "Pass --key-id, or put a `kid` in the JWK. Every token names its key in the kid header.",
    });
  }
  return { keyId: id, publicKey: parsed.data };
}

/** Render a connect run. `connected` and `registered` finish; `needs_reconnect` deliberately does not. */
export function formatConnectReport(report: ConnectReport, options: { json: boolean }): string {
  if (options.json) return `${formatJsonLine({ command: "dashboard.connect", ...report })}\n`;

  const rows: Row[] = [
    { name: "Connection", description: dim(report.connectionId) },
    { name: "Issuer", description: dim(report.issuer) },
    { name: "Worker", description: dim(report.workerUrl) },
    { name: "Scopes", description: dim(report.scopes.join(", ")) },
    ...(report.keyId === null ? [] : [{ name: "Key", description: dim(report.keyId) }]),
  ];

  if (report.status === "needs_reconnect") {
    // Registered, but the round-trip failed. Never `Done.` — the connection does not work yet.
    return [
      `Registered ${report.environment}, but the signed ping didn't get through.`,
      report.detail ?? "The worker didn't answer.",
      block(rows).trimEnd(),
      `Check the worker URL, then run pithy dashboard connect --env ${report.environment} --update --worker-url <url>.`,
      "",
    ].join("\n");
  }

  const headline = report.updated
    ? `Re-pointed ${report.environment}.`
    : report.status === "registered"
      ? `Registered ${report.environment}.`
      : `Connected ${report.environment}.`;
  const unproven =
    report.status === "registered"
      ? "No dashboard was involved, so nothing proved the key. Prove it with a signed ping from your own client.\n"
      : "";
  return `${headline}\n${block(rows)}${unproven}${formatDone()}\n`;
}

/** Render a rotation. The line about the old key staying live is the point of the whole command. */
export function formatRotateReport(report: RotateReport, options: { json: boolean }): string {
  if (options.json) return `${formatJsonLine({ command: "dashboard.rotate", ...report })}\n`;

  const previous = report.previousKeyIds.join(", ");
  if (report.status === "needs_reconnect") {
    const lines = [
      `Registered ${report.keyId} on ${report.environment}, but the signed ping didn't get through.`,
      report.detail ?? "The worker didn't answer with the new key.",
    ];
    // The reassurance that matters: an unproven successor costs nothing, because nothing was expired.
    if (previous !== "") lines.push(`${previous} is still live, so nothing is locked out.`);
    return `${lines.join("\n")}\n`;
  }

  const kept =
    previous === ""
      ? ""
      : `${previous} is still live. Expire it from your management client once it has proven ${report.keyId}.\n`;
  return `Rotated ${report.environment}. New key ${report.keyId}.\n${kept}${formatDone()}\n`;
}

/** Render a revocation. It succeeded locally whatever the management client had to say about it. */
export function formatDisconnectReport(report: DisconnectReport, options: { json: boolean }): string {
  if (options.json) return `${formatJsonLine({ command: "dashboard.disconnect", ...report })}\n`;
  if (!report.removed) return `Nothing connected to ${report.environment}.\n${formatDone()}\n`;

  const courtesy = report.dashboardNotified
    ? ""
    : `The management client wasn't told: ${report.detail ?? "no reason given."} Your revocation stands.\n`;
  return `Disconnected ${report.environment}.\n${courtesy}${formatDone()}\n`;
}

/** Render the registration state, keys and ages included. */
export function formatStatusReport(report: StatusReport, options: { json: boolean }): string {
  if (options.json) return `${formatJsonLine({ command: "dashboard.status", ...report })}\n`;
  if (!report.connected) {
    return [
      `Nothing connected to ${report.environment}.`,
      `Run pithy dashboard connect --env ${report.environment} to register a management client.`,
      "",
    ].join("\n");
  }

  const headline =
    report.status === "unverified"
      ? `${report.environment} is connected. Not verified — pass --verify to prove it with a signed ping.`
      : report.status === "connected"
        ? `${report.environment} is connected and answering.`
        : `${report.environment} needs reconnecting. ${report.detail ?? ""}`.trimEnd();

  const rows: Row[] = [
    { name: "Connection", description: dim(report.connectionId ?? "") },
    { name: "Issuer", description: dim(report.issuer ?? "") },
    { name: "Worker", description: dim(report.workerUrl ?? "") },
    { name: "Scopes", description: dim(report.scopes.join(", ")) },
  ];
  const keys = report.keys.map((key) => ({
    name: key.keyId,
    description: dim(`${key.live ? "live" : key.revokedAt ? "revoked" : "expired"}  ${key.ageDays} days`),
  }));
  const parts = [headline, block(rows).trimEnd(), block(keys).trimEnd()].filter((part) => part !== "");
  return `${parts.join("\n")}\n`;
}

/** True only at a real terminal without `--json` — the one condition a prompt is answerable. */
function isInteractive(json: boolean): boolean {
  return !json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Show the device code on stderr, so `--json`'s stdout line stays the only machine output. */
function announce(authorization: DeviceAuthorization): void {
  process.stderr.write(`Open ${authorization.verificationUri} and enter ${authorization.userCode}.\n`);
  process.stderr.write("▸ Waiting for approval...\n");
}

/** The device-code flow, wired to this CLI's announcer. */
const authorize = (client: DashboardClient): Promise<string> => authorizeDashboard(client, { announce });

/**
 * The recorder every write to the connection row records itself through (#294).
 *
 * Built over the handle {@link openConnectionRegistry} resolved, never over a database id looked up a
 * second time — the row and its record have to land in the same store, and on `dev` a resolved id names
 * the real remote database while the row goes to local Miniflare.
 *
 * Two things are deliberately tolerant. `audit` composed by **any** Worker means the project has a
 * trail, because a connection is project-wide and a `--worker` here only says which `wrangler.jsonc`
 * resolves the database. And Cloudflare credentials are optional: connecting a `dev` environment touches
 * no account, so demanding an account token to record it would make the trail depend on something the
 * action does not. Without one the row is written unattributed rather than dropped.
 *
 * **A mismatched account names nobody, and does not throw here (#236).** This resolves credentials only to
 * put a name on the actor, so it reads through {@link resolveCloudflare} rather than {@link cloudflareEnv}:
 * an operator whose pin and credentials disagree must not be recorded in their own trail as the account
 * the project does not claim, and a trail wiring must not be the thing that refuses a `dev` run that
 * touches no account at all. The refusal for the environments that *do* reach an account is
 * `openConnectionRegistry`'s, stated once, ahead of the fan-out.
 */
async function openAudit(projectDir: string, env: string, account: CloudflareAccountSelection | null) {
  const capabilities = await resolveWorkers({ projectDir }).then(projectCapabilities).catch(NO_CAPABILITIES);
  const resolved = resolveCloudflare({ account });
  const accountId = resolved.mismatch ? "" : (resolved.vars.CLOUDFLARE_ACCOUNT_ID ?? "");
  const apiToken = resolved.mismatch ? "" : (resolved.vars.CLOUDFLARE_API_TOKEN ?? "");
  const named = accountId !== "" && apiToken !== "";
  return (database: D1Database) =>
    createCliAudit({
      projectDir,
      env,
      // `--env` here is the environment acted on as well as where the row lands: a connection is per
      // environment, and this command touches exactly the one named.
      actedOn: env,
      capabilities,
      database,
      ...(named ? { clients: new CloudflareClients({ accountId, apiToken }), apiToken } : {}),
    });
}

/** A capability lookup that failed says nothing rather than throwing — auditing never breaks a command. */
const NO_CAPABILITIES = (): Capability[] => [];

/** Open the registry, run the work, and always release the driver. */
async function withRegistry<T>(
  options: { env: string; worker?: string },
  work: (registry: ConnectionRegistry) => Promise<T>,
): Promise<T> {
  // Every subcommand opens the registry, so this is the one door the `--env` check belongs behind —
  // and the one place the project's account is resolved for it (#234). A `--env staging` lookup opens
  // the app database over REST, and it is this project's account that says which one that is.
  const projectDir = process.cwd();
  const env = requireEnvironment(options.env);
  const account = await projectCloudflareAccount(projectDir);
  const registry = await openConnectionRegistry({
    projectDir,
    env,
    account,
    ...(options.worker === undefined ? {} : { worker: options.worker }),
    openAudit: await openAudit(projectDir, env, account),
  });
  try {
    return await work(registry);
  } finally {
    await registry.dispose();
  }
}

/** The flags every subcommand shares. */
const commonArgs = {
  env: ENV_ARG,
  worker: { type: "string", description: "Which worker's wrangler.jsonc resolves the app database (apps/<name>)" },
  origin: { type: "string", description: "The management client's origin (default https://app.pithy.sh)" },
  json: { type: "boolean", default: false, description: "Machine-readable output" },
} as const;

/**
 * Offer this Worker's grantable scopes at a terminal, preselected to the default grant.
 *
 * **The options are read off what the Worker composes, not typed here.** A hardcoded pair offered
 * `manifest:read` and `keys:rotate` and nothing else — so the operator was shown a choice between two
 * things neither of which reads any of their data, on a Worker composing capabilities with a dozen
 * scopes between them. Reading the composed surface means an adopter sees every operation their own
 * Worker actually exposes, described in the capability's own words.
 *
 * Preselected to {@link defaultGrant} — every read, plus the seam's own pair — because narrowing is the
 * point of showing the list at all: `keys:rotate` and `audit:events:read_detail` are exactly the grants
 * somebody may not want to make, and a grant nobody is shown is a grant nobody considers. `ping` is
 * absent throughout; it is not grantable (docs/CONTROL-PLANE.md §8).
 */
async function promptScopes(
  grantable: readonly GrantableScope[],
  preselected: ControlPlaneScope[],
): Promise<ControlPlaneScope[]> {
  const { isCancel, multiselect } = await import("@clack/prompts");
  const answer = await multiselect({
    message: "What may this management client do?",
    options: grantable.map((entry) => ({
      value: entry.scope,
      label: entry.scope,
      // The capability's own summary. A client renders these beside a pane; so does this.
      hint: `${entry.capability} — ${entry.summary}`,
    })),
    initialValues: preselected,
    required: false,
  });
  if (isCancel(answer)) {
    process.stderr.write("Cancelled.\n");
    process.exit(1);
  }
  return answer as ControlPlaneScope[];
}

/** Confirm a revocation at a terminal. `--yes` skips it, which is how CI runs the same command. */
/** What `revoke-key` did — enough for `--json` to be actionable without a second call. */
export interface RevokeKeyReport {
  environment: string;
  keyId: string;
  /** False when no key answered to that id. Re-running a revoke is not an error. */
  revoked: boolean;
  /** The connection after the write, or null when nothing matched. */
  connection: ControlPlaneConnection | null;
}

/** Render a key revocation, and say plainly when it left the connection with nothing live. */
export function formatRevokeKeyReport(report: RevokeKeyReport, options: { json: boolean }): string {
  if (options.json) return `${formatJsonLine({ command: "dashboard.revoke-key", ...report })}\n`;
  if (!report.revoked) {
    return `No key ${report.keyId} on ${report.environment}.\nRun pithy dashboard status --env ${report.environment} to list the keys.\n`;
  }

  // Revoking the last live key is allowed — a leaked key comes out whether or not it was the only one —
  // but it leaves the connection denying every call, and that must be said rather than discovered.
  const live = (report.connection?.keys ?? []).filter((key) => key.revokedAt === null && key.validUntil === null);
  const stranded =
    live.length === 0
      ? `That was the last live key, so ${report.environment} now denies every management call.\nRun pithy dashboard connect --env ${report.environment} to register a new one.\n`
      : "";
  return `Revoked ${report.keyId} on ${report.environment}.\n${stranded}${formatDone()}\n`;
}

async function confirmRevokeKey(keyId: string, env: string): Promise<void> {
  const { confirm, isCancel } = await import("@clack/prompts");
  const answer = await confirm({ message: `Revoke key ${keyId} on ${env}?`, initialValue: false });
  if (isCancel(answer) || answer !== true) {
    process.stderr.write("Cancelled.\n");
    process.exit(1);
  }
}

async function confirmDisconnect(env: string): Promise<void> {
  const { confirm, isCancel } = await import("@clack/prompts");
  const answer = await confirm({ message: `Disconnect the management client from ${env}?`, initialValue: false });
  if (isCancel(answer) || answer !== true) {
    process.stderr.write("Cancelled.\n");
    process.exit(1);
  }
}

/** `pithy dashboard connect` — register a management client, or re-point the one already registered. */
const connect = defineCommand({
  meta: { name: "connect", description: "Connect a management client to an environment, and prove it with a ping" },
  args: {
    ...commonArgs,
    worker: {
      type: "string",
      description: "Which worker composes the admin surface (apps/<name>). Required when the project has several",
    },
    "worker-url": { type: "string", description: "Override the resolved worker URL for this environment" },
    scope: { type: "string", description: "Grant one scope: --scope manifest:read (repeatable)" },
    update: { type: "boolean", default: false, description: "Re-point an existing connection's URL and scopes" },
    "public-key": { type: "string", description: "Register a JWK you generated yourself — no dashboard involved" },
    issuer: { type: "string", description: "With --public-key: the iss your own management client presents" },
    "key-id": { type: "string", description: "With --public-key: the key id, if the JWK carries no kid" },
    project: { type: "string", description: "Override the project name sent to the management client" },
  },
  // `rawArgs` because a repeated `--scope` only survives there.
  run: ({ args, rawArgs }) =>
    withErrorReporting(args.json, async () => {
      const scopes = collectScopeFlags(rawArgs) as ControlPlaneScope[];
      const offlinePath = args["public-key"] !== undefined;

      // Cross-arg rules, checked here rather than by a helper: docs/STACK.md proposes
      // requireWhen/exactlyOne, but they do not exist yet, and inventing them for one command would be
      // a worse trade than four explicit throws.
      if (offlinePath && args.issuer === undefined) {
        throw new ValidationError({
          message: "--public-key needs --issuer.",
          action: "Pass --issuer https://<your-client> — it is the iss every one of your tokens must carry.",
        });
      }
      if (!offlinePath && args.issuer !== undefined) {
        throw new ValidationError({
          message: "--issuer only applies with --public-key.",
          action: "Drop --issuer. The dashboard returns the issuer a connection is registered against.",
        });
      }
      if (!offlinePath && args["key-id"] !== undefined) {
        throw new ValidationError({
          message: "--key-id only applies with --public-key.",
          action: "Drop --key-id. The dashboard mints the keypair and names the key.",
        });
      }
      if (args.update && args["worker-url"] === undefined && scopes.length === 0 && !offlinePath) {
        throw new ValidationError({
          message: "Nothing to update.",
          action: "Pass --worker-url, --scope, or both.",
        });
      }

      let publicKey: OfflinePublicKey | undefined;
      if (offlinePath) {
        const raw = await readFile(args["public-key"] as string, "utf8");
        const key = parsePublicKey(raw, args["key-id"]);
        publicKey = { ...key, issuer: args.issuer as string };
      }

      const interactive = isInteractive(args.json);
      const projectDir = process.cwd();

      // Which Worker, at what address, with the seam mounted where — resolved from the project rather
      // than demanded. `--worker-url` still overrides (a proxy in front of the Worker has an address no
      // config knows), and an update that is only re-pointing scopes needs no address at all.
      //
      // This replaces a `--worker-url` that had no fallback whatsoever: the interactive path prompted for
      // it free-text, and the non-interactive path — the agent and CI path — simply threw.
      //
      // Resolve only when an address is actually needed: on any create, and on an update that is
      // re-pointing. A **key-only update** — `--update` with no `--worker-url`, including the offline
      // `--public-key` rotation — needs no address at all, and resolving one would demand a Worker that
      // resolves *and* composes the seam. That regressed offline rotation for a proxy-fronted project,
      // whose address no config knows and whose whole point is not needing us.
      const needsAddress = !args.update || args["worker-url"] !== undefined;
      const target = !needsAddress
        ? null
        : await resolveConnectTarget({
            projectDir,
            environment: args.env,
            ...(args.worker === undefined ? {} : { worker: args.worker }),
            ...(args["worker-url"] === undefined ? {} : { workerUrl: args["worker-url"] }),
          });
      if (target && interactive) process.stdout.write(`${dim(describeConnectTarget(target))}\n`);
      const workerUrl = target?.workerUrl ?? args["worker-url"];
      // What this Worker composes, which is what the grant is derived from. Empty on a key-only update,
      // where no address was resolved and no grant is being decided.
      const composed = target?.worker.capabilities ?? [];

      // Only on a create. On an update, no `--scope` means "leave the grant alone", and a prompt that
      // defaulted to everything would quietly widen it.
      //
      // `undefined` means "not specified — use the default grant"; `[]` means "deliberately nothing".
      // Collapsing those two is a real bug rather than a tidy-up: an operator who deselected every scope
      // at the prompt would have been handed the full default set, `keys:rotate` included — the exact
      // opposite of what they just said. So an explicit empty selection is passed through as empty.
      const granted: ControlPlaneScope[] | undefined =
        scopes.length > 0
          ? scopes
          : interactive && !args.update
            ? await promptScopes(grantableScopes(composed), defaultGrant(composed))
            : undefined;

      // One load, two answers. `--project` overrides only the *name* sent to the client; whether this
      // environment holds live data is the project's policy either way, and it is exactly the list that
      // gates a destructive seed. Resolved here because this is where the CLI knows it — a management
      // client guessing from the name gives an adopter who calls production `live` the safe-looking
      // treatment on their real users.
      const config = await loadProject(projectDir);
      const project = args.project ?? requireProjectName(config);
      const isProduction = isProductionEnv(args.env, config.seed?.productionEnvironments);

      const report = await withRegistry(args, (registry) =>
        connectDashboard({
          registry,
          project,
          environment: args.env,
          isProduction,
          ...(workerUrl === undefined ? {} : { workerUrl }),
          ...(target === null ? {} : { basePath: target.basePath }),
          ...(granted === undefined ? {} : { scopes: granted }),
          // The default grant is derived from these when no `--scope` narrowed it (#248). Sent even
          // when `granted` is set, so nothing depends on which branch above ran.
          capabilities: composed,
          update: args.update,
          ...(publicKey === undefined
            ? {
                client: httpDashboardClient(args.origin === undefined ? {} : { origin: args.origin }),
                authorize,
              }
            : { publicKey }),
        }),
      );
      process.stdout.write(formatConnectReport(report, { json: args.json }));
    }),
});

/** `pithy dashboard rotate` — append a successor key and prove it. Never expires the old one. */
const rotate = defineCommand({
  meta: { name: "rotate", description: "Register a successor key and prove it with a ping (the old key stays live)" },
  args: commonArgs,
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const report = await withRegistry(args, (registry) =>
        rotateDashboardKey({
          registry,
          client: httpDashboardClient(args.origin === undefined ? {} : { origin: args.origin }),
          environment: args.env,
          authorize,
        }),
      );
      process.stdout.write(formatRotateReport(report, { json: args.json }));
    }),
});

/** `pithy dashboard disconnect` — delete the registration. Local, immediate, and unilateral. */
const disconnect = defineCommand({
  meta: { name: "disconnect", description: "Revoke this environment's management-client connection" },
  args: {
    ...commonArgs,
    yes: { type: "boolean", default: false, description: "Skip the confirmation (how CI runs it)" },
    local: { type: "boolean", default: false, description: "Delete the row without telling the management client" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      if (isInteractive(args.json) && !args.yes) await confirmDisconnect(args.env);

      const report = await withRegistry(args, (registry) =>
        disconnectDashboard({
          registry,
          environment: args.env,
          // `--local` skips the courtesy call entirely. The revocation is identical either way; this
          // only avoids a browser sign-in when the dashboard is unreachable or no longer wanted.
          ...(args.local
            ? {}
            : {
                client: httpDashboardClient(args.origin === undefined ? {} : { origin: args.origin }),
                authorize,
              }),
        }),
      );
      process.stdout.write(formatDisconnectReport(report, { json: args.json }));
    }),
});

/**
 * `pithy dashboard revoke-key` — pull one key without tearing down the connection.
 *
 * The narrow instrument beside `disconnect`'s blunt one. A management client that leaked a single key
 * does not need the whole connection rebuilt, and an adopter who has to choose between "do nothing" and
 * "reconnect everything" will pick the wrong one under pressure.
 *
 * Purely local: it writes `revokedAt` into their own D1 and tells nobody. That is the point — revocation
 * that needed the other side's cooperation would not be revocation.
 */
const revokeKey = defineCommand({
  meta: { name: "revoke-key", description: "Revoke one registered key immediately, leaving the connection in place" },
  args: {
    ...commonArgs,
    "key-id": { type: "string", required: true, description: "The key to revoke, as reported by `status`" },
    yes: { type: "boolean", default: false, description: "Skip the confirmation (how CI runs it)" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      if (isInteractive(args.json) && !args.yes) await confirmRevokeKey(args["key-id"], args.env);

      const report = await withRegistry(args, async (registry) => {
        const updated = await registry.revokeKey(args["key-id"], new Date());
        return { environment: args.env, keyId: args["key-id"], revoked: updated !== null, connection: updated };
      });
      process.stdout.write(formatRevokeKeyReport(report, { json: args.json }));
    }),
});

/** `pithy dashboard status` — what is registered, and (with `--verify`) whether it still answers. */
const status = defineCommand({
  meta: { name: "status", description: "Report this environment's connection, its keys, and their ages" },
  args: {
    ...commonArgs,
    verify: { type: "boolean", default: false, description: "Prove the connection with a signed ping" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const client = args.verify
        ? httpDashboardClient(args.origin === undefined ? {} : { origin: args.origin })
        : undefined;

      const report = await withRegistry(args, async (registry) =>
        dashboardStatus({
          registry,
          environment: args.env,
          // Looking is free; proving costs a browser sign-in. So the probe is opt-in, and its absence
          // is reported as `unverified` rather than guessed at.
          ...(client === undefined
            ? {}
            : {
                verify: async (connection) => {
                  const token = await authorize(client);
                  return client.verifyConnection(token, connection.id, connection.workerUrl);
                },
              }),
        }),
      );
      process.stdout.write(formatStatusReport(report, { json: args.json }));
    }),
});

export default defineCommand({
  meta: {
    name: "dashboard",
    description: "Connect, rotate, revoke, and inspect a management client (control-plane seam)",
  },
  subCommands: { connect, rotate, "revoke-key": revokeKey, disconnect, status },
});
