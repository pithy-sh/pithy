// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { z } from "zod";
import { ensureOwnerOnlyDirFor } from "../devSecrets/mode";
import { stateDir } from "../notifier/state";
import { writeFileAtomic } from "../project/atomic";
import { readFileOutcome } from "../project/readOptionalFile";
import { keysDir } from "./keyFile";
import { WorkloadTokenSource } from "./workload";

/**
 * What `pithy mcp serve --connection <alias>` needs to find its Worker and prove itself (#723).
 *
 * **The client configuration names the connection, never the credential.** A config entry runs `pithy mcp serve
 * --connection <alias>`, and the server reads the rest from here: the Worker, the connection, and where its
 * credential is — a key file's path, or a workload token's source. Nothing in a record is a secret either: a key
 * record names a file and a trust record names a variable.
 *
 * **Two places, by credential, because the credential decides who can use it.** A key is one machine's, so its
 * record lives in that operator's config directory (`<config>/mcp-connections.json`) beside the key, and its
 * client entry is written in user scope. A trust is any job's that can run the workflow, and CI starts from a
 * checkout, so its record is committed with the project (`.pithy/mcp.jsonc`) and its client entry is written in
 * project scope.
 *
 * **The binding holds on read, not only on write.** The project's store arrives with whatever checkout is open,
 * and a key connection's client entry is live in every one of them. So a key record is read only from the
 * operator's store and only for `<keys>/<connectionId>.jwk`, a trust record only from the project's, and an alias
 * both stores hold is refused — otherwise a cloned repository could point the operator's own entry at any Worker,
 * any variable or any key file.
 */

/** The `pithy mcp` connection's name, and its client entry's key: `pithy-<project>-<env>`, `-ci` for a trust. */
export const ConnectionAlias = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "An alias is lowercase letters, digits and hyphens.")
  .describe(
    "The connection's alias — `pithy-<project>-<env>`, or `pithy-<project>-<env>-ci` for a trust — and the key its client entries are written under.",
  );

/** A key credential: which key, signing as which issuer, kept in which file. */
const KeyCredential = z
  .object({
    kind: z.literal("key").describe("A registered Ed25519 key on this machine."),
    keyId: z.string().min(1).describe("The key id the connection registered it under."),
    issuer: z.string().min(1).describe("The `iss` the connection stores for it."),
    keyFile: z.string().min(1).describe("The absolute path of the private key, `0600`."),
  })
  .describe("A key the server signs every call with.");

/** A trust credential: which trust, for which audience, with its token from where. */
const TrustCredential = z
  .object({
    kind: z.literal("oidc").describe("An OIDC trust: the workload's own token, per call."),
    trustId: z.string().min(1).describe("The trust a call names."),
    audience: z.string().min(1).describe("The `aud` the workload's token is minted for."),
    source: WorkloadTokenSource,
  })
  .describe("A workload identity the server presents on every call.");

/** One client entry written for a connection, so `disconnect` removes exactly what `connect` wrote. */
const ClientTarget = z
  .object({
    client: z.string().min(1).describe("The client's `--client` id."),
    scope: z.enum(["project", "user"]).describe("Which of its configurations the entry is in."),
  })
  .describe("A client configuration this connection was written into.");

/** One connection the server can serve. */
export const McpConnectionRecord = z
  .object({
    alias: ConnectionAlias,
    project: z.string().min(1).describe("The project's name."),
    environment: z.string().min(1).describe("The environment the connection is bound to."),
    connectionId: z.string().min(1).describe("The connection's id — a token's `aud`."),
    workerUrl: z.string().min(1).describe("The Worker the server calls."),
    basePath: z.string().min(1).describe("Where that Worker mounts the control-plane seam."),
    credential: z
      .discriminatedUnion("kind", [KeyCredential, TrustCredential])
      .describe("How every call proves itself."),
    clients: z.array(ClientTarget).describe("The client entries written for it."),
  })
  .describe("One control-plane MCP connection: its Worker and how the server proves itself to it.");
export type McpConnectionRecord = z.infer<typeof McpConnectionRecord>;

/** A store's file: every connection in it, by alias. */
const McpConnectionStore = z
  .object({
    connections: z.record(ConnectionAlias, McpConnectionRecord).describe("Every connection, by alias."),
  })
  .describe("The control-plane MCP connections recorded in one place.");
type McpConnectionStore = z.infer<typeof McpConnectionStore>;

/** Which of the two stores. */
export type StoreScope = "project" | "user";

/** The operator's store. */
export function userStorePath(): string {
  return join(stateDir(), "mcp-connections.json");
}

/** The project's store. */
export function projectStorePath(projectDir: string): string {
  return join(projectDir, ".pithy", "mcp.jsonc");
}

/** The store a credential's record belongs in. */
export function storeFor(record: Pick<McpConnectionRecord, "credential">): StoreScope {
  return record.credential.kind === "key" ? "user" : "project";
}

/** Read a store. Absent is empty; a store that does not parse is refused rather than overwritten. */
export async function readStore(path: string): Promise<McpConnectionStore> {
  const read = await readFileOutcome(path);
  if (read.state === "absent") return { connections: {} };
  if (read.state === "unreadable") {
    throw new PreconditionFailedError({
      message: `Could not read ${path}.`,
      action: "Check its permissions, then run the command again.",
      detail: `readFileOutcome: ${read.code ?? "unknown error"}`,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(JSON.stringify(parse(read.text)));
  } catch {
    raw = null;
  }
  const parsed = McpConnectionStore.safeParse(raw);
  if (!parsed.success) {
    throw new PreconditionFailedError({
      message: `${path} is not a connection store Pithy can read, so nothing was changed.`,
      action: `Fix or remove ${path}, then run the command again.`,
      detail: z.prettifyError(parsed.error),
    });
  }
  return parsed.data;
}

/** The comment a project store is written with, since it is committed and read by people. */
const PROJECT_HEADER = `// Control-plane MCP connections for CI, written by \`${commandName("mcp connect")}\`. No credential is stored here:\n// each names an OIDC trust and where the job's identity token comes from.\n`;

/** Write a store: the operator's `0600` in a `0700` directory, the project's as configuration. */
async function writeStore(path: string, scope: StoreScope, store: McpConnectionStore): Promise<void> {
  const body = `${JSON.stringify(store, null, 2)}\n`;
  if (scope === "user") {
    await ensureOwnerOnlyDirFor(path);
    await writeFileAtomic(path, body, { mode: 0o600 });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${PROJECT_HEADER}${body}`, { mode: 0o644 });
}

/** Where each scope's store is, for one project, and the directory a key record's file must be in. */
export interface StorePaths {
  readonly project: string;
  readonly user: string;
  readonly keys: string;
}

/** The two stores for a project directory. */
export function storePaths(projectDir: string): StorePaths {
  return { project: projectStorePath(projectDir), user: userStorePath(), keys: keysDir() };
}

/** A connection id that names a file in the keys directory and nowhere else. */
const KEY_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Refuse a record its store may not hold, naming the file. `saveConnection` never writes one. */
function checkRecord(paths: StorePaths, scope: StoreScope, alias: string, record: McpConnectionRecord): void {
  const path = paths[scope];
  const refuse = (problem: string, detail: string): never => {
    throw new PreconditionFailedError({
      message: `${path} holds ${alias} ${problem}, so nothing was done.`,
      action: `Remove ${alias} from ${path}, then connect it again with ${commandName("mcp connect")}.`,
      detail,
    });
  };
  if (record.alias !== alias) refuse(`under another alias, ${record.alias}`, "alias key and record differ");
  const kind = record.credential.kind;
  if (storeFor(record) !== scope) {
    refuse(
      kind === "key"
        ? "as a key connection, and a key is recorded only in the operator's store"
        : "as a trust connection, and a trust is recorded only in the project's store",
      `${kind} record read from the ${scope} store`,
    );
  }
  if (record.credential.kind === "key") {
    const keyFile = resolve(record.credential.keyFile);
    const expected = `${record.connectionId}.jwk`;
    if (
      !KEY_FILE_ID.test(record.connectionId) ||
      dirname(keyFile) !== resolve(paths.keys) ||
      basename(keyFile) !== expected
    ) {
      refuse(
        `with a key file outside ${paths.keys}`,
        `keyFile ${record.credential.keyFile} is not ${join(paths.keys, expected)}`,
      );
    }
  }
}

/** Add or replace one record in the store its credential belongs in. */
export async function saveConnection(paths: StorePaths, record: McpConnectionRecord): Promise<StoreScope> {
  const scope = storeFor(record);
  const store = await readStore(paths[scope]);
  store.connections[record.alias] = McpConnectionRecord.parse(record);
  await writeStore(paths[scope], scope, store);
  return scope;
}

/** Remove one record. False when it was not there. */
export async function removeConnection(paths: StorePaths, scope: StoreScope, alias: string): Promise<boolean> {
  const store = await readStore(paths[scope]);
  if (store.connections[alias] === undefined) return false;
  delete store.connections[alias];
  await writeStore(paths[scope], scope, store);
  return true;
}

/** A record, and the store it came from. */
export interface FoundConnection {
  readonly record: McpConnectionRecord;
  readonly scope: StoreScope;
}

/** Refuse an alias both stores hold: a project record must never stand in for the operator's. */
function refuseShadow(paths: StorePaths, alias: string): never {
  throw new PreconditionFailedError({
    message: `${alias} is recorded in both ${paths.project} and ${paths.user}, so nothing was done.`,
    action: `Remove ${alias} from ${paths.project}. A key connection is recorded only in ${paths.user}.`,
    detail: "an alias in both stores",
  });
}

/** Find a connection by alias. `null` when neither store has it; refused when both do, or when its store may not hold it. */
export async function findConnection(paths: StorePaths, alias: string): Promise<FoundConnection | null> {
  const project = (await readStore(paths.project)).connections[alias];
  const user = (await readStore(paths.user)).connections[alias];
  if (project !== undefined && user !== undefined) refuseShadow(paths, alias);
  const found: FoundConnection | null =
    project !== undefined
      ? { record: project, scope: "project" }
      : user !== undefined
        ? { record: user, scope: "user" }
        : null;
  if (found !== null) checkRecord(paths, found.scope, alias, found.record);
  return found;
}

/** Every connection in both stores, the project's first, refused on any record {@link findConnection} would refuse. */
export async function listConnections(paths: StorePaths): Promise<FoundConnection[]> {
  const project = (await readStore(paths.project)).connections;
  const user = (await readStore(paths.user)).connections;
  const found: FoundConnection[] = [];
  for (const [scope, connections] of [
    ["project", project],
    ["user", user],
  ] as const) {
    for (const [alias, record] of Object.entries(connections)) {
      if (scope === "project" && user[alias] !== undefined) refuseShadow(paths, alias);
      checkRecord(paths, scope, alias, record);
      found.push({ record, scope });
    }
  }
  return found;
}

/**
 * The alias a project's environment is served under: `pithy-<project>-<env>` for a key, `pithy-<project>-<env>-ci`
 * for a trust.
 *
 * **One alias per credential kind, because the two live in different stores and can share a connection.** A
 * developer's key and CI's trust on one environment are the flow `docs/AGENT-ACCESS.md` §6 describes, and the trust
 * joins the key's connection. The key's record is in the developer's store and the trust's is committed with the
 * project, so one shared alias would have the pulled `.pithy/mcp.jsonc` shadow the developer's own record — and
 * their server, and `pithy mcp status`, would be refused in that checkout.
 */
export function connectionAlias(project: string, environment: string, credential: "key" | "oidc" = "key"): string {
  const suffix = credential === "oidc" ? "-ci" : "";
  return ConnectionAlias.parse(`pithy-${project}-${environment}${suffix}`.toLowerCase());
}
