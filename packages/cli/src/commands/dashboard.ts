// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { Ed25519PublicJwk } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneScope, SEAM_SCOPES } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { z } from "zod";
import { type DashboardClient, type DeviceAuthorization, httpDashboardClient } from "../dashboard/api";
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
import { type ConnectionRegistry, openConnectionRegistry } from "../dashboard/registry";
import { loadProject, resolveProjectName } from "../project/config";
import { ENV_ARG, requireEnvironment } from "../project/environment";
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

/** Open the registry, run the work, and always release the driver. */
async function withRegistry<T>(
  options: { env: string; worker?: string },
  work: (registry: ConnectionRegistry) => Promise<T>,
): Promise<T> {
  // Every subcommand opens the registry, so this is the one door the `--env` check belongs behind.
  const registry = await openConnectionRegistry({
    projectDir: process.cwd(),
    env: requireEnvironment(options.env),
    ...(options.worker === undefined ? {} : { worker: options.worker }),
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

/** Prompt for the Worker URL when a human is attached and did not pass one. */
async function promptWorkerUrl(): Promise<string> {
  const { isCancel, text } = await import("@clack/prompts");
  const answer = await text({
    message: "This environment's worker URL — the address the management client calls",
    placeholder: "https://api.example.com",
  });
  if (isCancel(answer)) {
    process.stderr.write("Cancelled.\n");
    process.exit(1);
  }
  return answer as string;
}

/**
 * Offer the seam's grantable scopes at a terminal. Every one is off nothing by default and on
 * everything by default here, because a connect run the operator narrows is the point: `keys:rotate`
 * is exactly the grant somebody may not want to give, and a flag they never see is a flag they never
 * consider. `ping` is absent — it is not grantable (docs/CONTROL-PLANE.md §8).
 */
async function promptScopes(): Promise<ControlPlaneScope[]> {
  const { isCancel, multiselect } = await import("@clack/prompts");
  const answer = await multiselect({
    message: "What may this management client do?",
    options: [
      { value: "manifest:read", label: "manifest:read", hint: "Read which capabilities this worker composes" },
      { value: "keys:rotate", label: "keys:rotate", hint: "Register and expire its own signing keys" },
    ],
    initialValues: [...SEAM_SCOPES],
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
    "worker-url": { type: "string", description: "This environment's deployed worker URL" },
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
      // A create needs an address; an update may be re-pointing scopes only.
      const needsUrl = args["worker-url"] === undefined && !args.update;
      const workerUrl = needsUrl && interactive ? await promptWorkerUrl() : args["worker-url"];
      // Only on a create. On an update, no `--scope` means "leave the grant alone", and a prompt that
      // defaulted to everything would quietly widen it.
      //
      // `undefined` means "not specified — use the default grant"; `[]` means "deliberately nothing".
      // Collapsing those two is a real bug rather than a tidy-up: an operator who deselected every scope
      // at the prompt would have been handed the full default set, `keys:rotate` included — the exact
      // opposite of what they just said. So an explicit empty selection is passed through as empty.
      const granted: ControlPlaneScope[] | undefined =
        scopes.length > 0 ? scopes : interactive && !args.update ? await promptScopes() : undefined;

      const projectDir = process.cwd();
      const project = args.project ?? (await resolveProjectName(await loadProject(projectDir), projectDir));

      const report = await withRegistry(args, (registry) =>
        connectDashboard({
          registry,
          project,
          environment: args.env,
          ...(workerUrl === undefined ? {} : { workerUrl }),
          ...(granted === undefined ? {} : { scopes: granted }),
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
