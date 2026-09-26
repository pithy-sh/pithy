// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { writeFileAtomic } from "../project/atomic";
import { readFileOutcome } from "../project/readOptionalFile";
import { ensureScaffoldPath, pathExists } from "../project/scaffold";
import { MCP_CLIENTS, type McpClient, type Scope, scopesOf } from "./clients";
import type { DocumentWriter, MergeOutcome, RemoveOutcome } from "./document";
import type { HomeOptions } from "./home";
import { resolveUnder } from "./home";
import { jsonWriter } from "./json";
import { tomlWriter } from "./toml";
import { yamlWriter } from "./yaml";

/**
 * Where the registry, the writers and the filesystem meet.
 *
 * Everything above this module works in one client and one document; everything below it works in one
 * syntax. This is the layer that resolves a row and a scope to a path on *this* machine, reads what is
 * there, hands it to the right writer, and writes the answer back — and it is the only layer that
 * touches a disk.
 *
 * **Nothing here throws for a client.** A run with `--all` reaches ten files on a machine Pithy does not
 * administer: one of them is read-only, one belongs to root, one is half-written by an editor that
 * crashed. Any of those raising would take the other nine with it, so every failure becomes a `refused`
 * result carrying the sentence that explains it, and the command reports per client and exits on the
 * whole. That is the same reasoning `readFileOutcome` exists for, applied one layer up.
 *
 * **A run that changes nothing writes nothing.** `unchanged` never reaches `writeFileAtomic`, so a second
 * `pithy docs connect` does not restat, rewrite or touch the file's mtime — which is what makes the
 * idempotency the issue asks for observable from outside rather than merely true of the bytes.
 */

/** Everything a resolution needs about the machine it is running on. */
export interface McpOptions {
  /** The project root. Project-scope paths resolve against it. */
  readonly projectDir: string;
  /** How the operator's own directories resolve. Every term injectable, so a test never reaches a real home. */
  readonly home?: HomeOptions;
}

/** One client, one scope, and the file that pair names here. */
export interface Target {
  /** The client being written. */
  readonly client: McpClient;
  /** Which of its configurations. */
  readonly scope: Scope;
  /** The absolute path, resolved for this platform. */
  readonly path: string;
  /**
   * The directory a project-scope path must stay inside, or `null` for a user-scope one.
   *
   * A project path is composed from a root the operator did not choose — a repository they cloned — so
   * every segment of it is content somebody else wrote, and {@link contained} holds it to that root. A
   * user path has no such root: it is `$HOME`, and the operator owns every link in it.
   */
  readonly root: string | null;
}

/** What happened to one file. `refused` is the writer's or the filesystem's, and carries its reason. */
export type ConnectState = MergeOutcome | "refused";

/** The outcome for one client and scope. */
export interface ConnectResult {
  /** The client's registry id. */
  readonly client: string;
  /** Which configuration was written. */
  readonly scope: Scope;
  /** The file. Absolute, because that is the one spelling an operator can act on. */
  readonly path: string;
  /** Added, updated, unchanged — or refused, in which case nothing was written. */
  readonly state: ConnectState;
  /** Why it was refused, or `null` when it was not. One line, never the file's contents. */
  readonly reason: string | null;
  /** The snippet to add by hand. Present only on a refusal, which is the only time anybody needs it. */
  readonly snippet: string | null;
}

/** The outcome of taking the entry back out. */
export interface DisconnectResult {
  /** The client's registry id. */
  readonly client: string;
  /** Which configuration was read. */
  readonly scope: Scope;
  /** The file. */
  readonly path: string;
  /** Removed, absent — or refused, in which case nothing was written. */
  readonly state: RemoveOutcome | "refused";
  /** Why it was refused, or `null`. */
  readonly reason: string | null;
}

/** What `pithy docs status` reports about one client, in one scope. */
export interface ScopeStatus {
  /** Which configuration this line is about. */
  readonly scope: Scope;
  /** The file this scope resolves to, whether or not it is there. */
  readonly path: string;
  /** Whether a `pithy` entry is in it. */
  readonly connected: boolean;
  /** The address that entry names, or `null` for a bridged entry and for no entry at all. */
  readonly url: string | null;
  /** True when the entry is what this version of Pithy would write. */
  readonly current: boolean;
}

/** What `pithy docs status` reports about one client. */
export interface ClientStatus {
  /** The registry id. */
  readonly client: string;
  /** The tool's own name. */
  readonly label: string;
  /** Whether this tool looks installed for this operator. */
  readonly detected: boolean;
  /** One line per scope the client declares. */
  readonly scopes: readonly ScopeStatus[];
}

/** The writer for a syntax. The one place a format becomes a code path. */
export function writerFor(client: McpClient): DocumentWriter {
  switch (client.format) {
    case "json":
    case "jsonc":
      return jsonWriter;
    case "toml":
      return tomlWriter;
    case "yaml":
      return yamlWriter;
  }
}

/** The platform a resolution is for — anything that is not macOS or Windows resolves the way Linux does. */
function platformOf(options: McpOptions): "linux" | "darwin" | "win32" {
  const platform = options.home?.platform ?? process.platform;
  if (platform === "darwin" || platform === "win32") return platform;
  return "linux";
}

/**
 * The file a client and scope name on this machine.
 *
 * A project path is joined onto `projectDir` and a user path onto whichever base its row declared for
 * this platform. Asking for a scope a client does not declare is a programming error rather than an
 * operator's mistake — `scopesOf` is what a caller filters by — so it throws rather than returning null.
 */
export function targetFor(client: McpClient, scope: Scope, options: McpOptions): Target {
  if (scope === "project") {
    if (client.project === null) {
      throw new PithyError({
        code: "core/internal",
        status: 500,
        message: `${client.label} has no project configuration.`,
        detail: `targetFor asked for the project scope of ${client.id}, which scopesOf() does not offer`,
      });
    }
    return { client, scope, path: join(options.projectDir, ...client.project), root: options.projectDir };
  }
  return { client, scope, path: resolveUnder(client.user[platformOf(options)], options.home), root: null };
}

/** Every target a client declares, in scope order. */
export function targetsFor(client: McpClient, options: McpOptions): Target[] {
  return scopesOf(client).map((scope) => targetFor(client, scope, options));
}

/**
 * Whether this tool looks installed — the row's detection path, resolved and asked about.
 *
 * `pathExists` rather than `existsSync`, and the difference is the point: it `lstat`s, so a detection
 * path that is a symlink answers *yes, something is there* without reaching through it. That is the right
 * answer to the question detection asks — an operator who symlinked `~/.cursor` somewhere still runs
 * Cursor — and it is also the probe `project/scaffold.ts` exists to be the one of. A module that both
 * writes files and probes with a link-following call is what `project/scaffold.test.ts` fails, for the
 * TOCTOU it opens in every module that has ever done both.
 */
export async function isInstalled(client: McpClient, options: McpOptions): Promise<boolean> {
  return pathExists(resolveUnder(client.detect[platformOf(options)], options.home));
}

/** Every installed client, in registry order. */
export async function detectedClients(options: McpOptions): Promise<McpClient[]> {
  const detected = await Promise.all(MCP_CLIENTS.map((client) => isInstalled(client, options)));
  return MCP_CLIENTS.filter((_client, index) => detected[index]);
}

/**
 * The entry on its own — what `--print` emits and what a refusal offers to paste.
 *
 * Deliberately without the row's `preamble`. A preamble is what a file Pithy *creates* needs beside the
 * entry, and both the surfaces this feeds are about a file that is already there: pasting Continue's
 * `name:`/`version:`/`schema:` into an existing `config.yaml` would declare them twice.
 */
export function snippetFor(client: McpClient): string {
  return writerFor(client).snippet(client);
}

/**
 * Whether a project-scope path stays inside the project, as one sentence or `null` for yes.
 *
 * **A project file is composed from a root the operator did not write.** `.zed/settings.json` and the six
 * other project paths are segments of somebody else's repository, and `git clone` creates a symlink in
 * the checkout as the victim — so `writeFileAtomic`'s rule, which refuses a link *somebody else* owns,
 * reads that link as ours and follows it. A repository shipping `.continue/mcpServers/pithy.yaml` as a
 * link to anywhere the operator can write would have this command create or rewrite that file on the
 * first `--scope project` run. `ensureScaffoldPath` is the repository's one answer to that question and
 * seven other writers already route through it; this is the eighth.
 *
 * **Reported rather than thrown**, on the same reasoning as `devSecrets/generate.ts`: one planted link in
 * a checkout must cost that client its line, not the other nine theirs.
 *
 * A user path is not gated. There is no root to contain it to — it *is* the operator's home — and every
 * link on the way there is one they made.
 */
async function contained(target: Target): Promise<string | null> {
  if (target.root === null) return null;

  // **The directory, not the file.** `ensureScaffoldPath` refuses a non-directory anywhere on the way
  // *including the target*, which is right for the scaffolds it was written for and wrong here: our
  // target is a file, so handing it the file would refuse every project already connected. Every other
  // caller that writes a file passes `dirname` for the same reason (`ui/scaffold.ts`).
  const gate = await ensureScaffoldPath(target.root, dirname(target.path)).then(
    () => null,
    (error: unknown) => (error instanceof PithyError ? error.payload.message : `Cannot reach ${target.path}.`),
  );
  if (gate !== null) return gate;

  // And then the file itself, which `ensureScaffoldPath` no longer sees. A link here redirects the write
  // exactly as completely as one on the way to it, and `git clone` creates it as the victim, so
  // `writeFileAtomic`'s "is this link ours" rule reads it as ours and follows it.
  const entry = await lstat(target.path).catch(() => null);
  if (entry?.isSymbolicLink()) {
    return `${relative(target.root, target.path)} is a symlink.`;
  }
  return null;
}

/** Write the bytes, creating the parent directory a tool has not made yet. */
async function writeTarget(path: string, document: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // 0o644 for a file created from scratch: these are configuration, not credentials, and `writeFileAtomic`
  // keeps a tighter mode a tool already chose for one of its own files.
  await writeFileAtomic(path, document, { mode: 0o644 });
}

/** A `PithyError` raised while touching one client's file, as that client's refusal. */
function refusalOf(error: unknown, path: string): string {
  if (error instanceof PithyError) return error.payload.message;
  return `Could not write ${path}.`;
}

/** Write the entry into one target. */
export async function connect(target: Target): Promise<ConnectResult> {
  const { client, scope, path } = target;
  const writer = writerFor(client);
  const snippet = snippetFor(client);
  const refused = (reason: string): ConnectResult => ({
    client: client.id,
    scope,
    path,
    state: "refused",
    reason,
    snippet,
  });

  const outside = await contained(target);
  if (outside !== null) return refused(outside);

  // A file that will not open is neither absent nor readable, and that third answer is this client's
  // refusal rather than the run's. The reason names the errno and the path, never the contents — which
  // in `~/.claude.json` include an OAuth session.
  const read = await readFileOutcome(path);
  if (read.state === "unreadable") return refused(`Could not read ${path} (${read.code ?? "unknown error"}).`);

  // The preamble goes in whichever scope created the file. `~/.continue/config.yaml` is a whole document
  // and needs the same three keys the project block file does — Continue writes it on first run, so this
  // is the rare path, and a file Pithy creates is still a file Pithy has to leave valid.
  const merged = writer.merge(read.state === "read" ? read.text : null, client, client.preamble);
  if (merged.state === "refused") return refused(merged.reason);

  if (merged.outcome !== "unchanged") {
    try {
      await writeTarget(path, merged.document);
    } catch (error) {
      return refused(refusalOf(error, path));
    }
  }
  return { client: client.id, scope, path, state: merged.outcome, reason: null, snippet: null };
}

/** Take the entry back out of one target, leaving everything else in it alone. */
export async function disconnect(target: Target): Promise<DisconnectResult> {
  const { client, scope, path } = target;
  const writer = writerFor(client);
  const refused = (reason: string): DisconnectResult => ({
    client: client.id,
    scope,
    path,
    state: "refused",
    reason,
  });

  const outside = await contained(target);
  if (outside !== null) return refused(outside);

  const read = await readFileOutcome(path);
  if (read.state === "unreadable") return refused(`Could not read ${path} (${read.code ?? "unknown error"}).`);
  // Nothing at that path is the end state a removal was asking for, not a failure.
  if (read.state === "absent") return { client: client.id, scope, path, state: "absent", reason: null };

  const removed = writer.remove(read.text, client);
  if (removed.state === "refused") return refused(removed.reason);

  if (removed.outcome === "removed") {
    try {
      await writeTarget(path, removed.document);
    } catch (error) {
      return refused(refusalOf(error, path));
    }
  }
  return { client: client.id, scope, path, state: removed.outcome, reason: null };
}

/** What one scope of one client says today. A file that is absent or unreadable is simply not connected. */
async function scopeStatus(target: Target): Promise<ScopeStatus> {
  const { client, scope, path } = target;
  const blank: ScopeStatus = { scope, path, connected: false, url: null, current: false };
  // A path this command would refuse to write is not this project's file, so it is not reported as one.
  if ((await contained(target)) !== null) return blank;
  const read = await readFileOutcome(path);
  if (read.state !== "read") return blank;
  const reading = writerFor(client).read(read.text, client);
  if (reading.state === "refused" || reading.entry === null) return blank;
  return { scope, path, connected: true, url: reading.entry.url, current: reading.entry.current };
}

/** Every client, whether it is installed, and what each of its configurations says. */
export async function status(options: McpOptions): Promise<ClientStatus[]> {
  return Promise.all(
    MCP_CLIENTS.map(async (client) => ({
      client: client.id,
      label: client.label,
      detected: await isInstalled(client, options),
      scopes: await Promise.all(targetsFor(client, options).map((target) => scopeStatus(target))),
    })),
  );
}
