// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { ensureOwnerOnlyDirFor } from "../devSecrets/mode";
import { stateDir } from "../notifier/state";
import { writeFileAtomic } from "../project/atomic";
import { lstatAsProject } from "../project/linkView";

/**
 * An agent's private key on disk (#723, `docs/AGENT-ACCESS.md` §6.1).
 *
 * **A file, with the custody of an SSH key.** No keychain: not every Linux host has one, and one behavior on
 * every host is worth more than a second store on some of them. `pithy mcp connect` writes the key to
 * `<config>/keys/<connectionId>.jwk`, mode `0600`, in a `0700` directory, and `pithy mcp serve` reads it.
 *
 * **The server refuses a key it cannot be sure is private.** A file another account can read is a key that
 * account holds, and a file another account owns is a key that account chose — either way the signatures it
 * makes are not this operator's. Refusing names the fix, as `ssh` does, rather than tightening silently: a mode
 * that widened is something the operator should learn happened.
 *
 * **Windows is exempt from the mode check**, because a POSIX mode there says nothing about who can read the file.
 * The directory is still the operator's own, under `%APPDATA%`.
 */

/** Group and other bits — none may be set on a private key. */
const SHARED_BITS = 0o077;

/** An Ed25519 private key as a JWK: the public `x` and the private `d`. */
export const AgentPrivateJwk = z
  .object({
    kty: z.literal("OKP").describe("Always `OKP`."),
    crv: z.literal("Ed25519").describe("Always `Ed25519`."),
    x: z.string().min(1).describe("The public half, base64url."),
    d: z.string().min(1).describe("The private half, base64url."),
    kid: z.string().min(1).describe("The key id the connection registered it under."),
  })
  .describe("An agent's Ed25519 signing key, as `pithy mcp connect` wrote it.");
export type AgentPrivateJwk = z.infer<typeof AgentPrivateJwk>;

/** Where this machine's agent keys live: `<config>/keys`. */
export function keysDir(): string {
  return join(stateDir(), "keys");
}

/** The key file for one connection. */
export function keyFilePath(connectionId: string, dir: string = keysDir()): string {
  return join(dir, `${connectionId}.jwk`);
}

/** Write a key, `0600`, in a `0700` directory. Replaces nothing: a connection's key is written once. */
export async function writeAgentKey(path: string, key: AgentPrivateJwk): Promise<void> {
  await ensureOwnerOnlyDirFor(path);
  await writeFileAtomic(path, `${JSON.stringify(AgentPrivateJwk.parse(key), null, 2)}\n`, { mode: 0o600 });
}

/** What the permission check needs to know about the process and the platform. Injected in a test. */
export interface KeyFileChecks {
  /** The platform. Windows skips the mode check. */
  readonly platform?: NodeJS.Platform;
  /** This process's effective uid, or undefined where there is none. */
  readonly uid?: number | undefined;
}

/**
 * Why a key file is not safe to sign with, or `null` when it is. Exported for `pithy mcp status`, which reports
 * the same answer `serve` acts on.
 */
export async function keyFileProblem(path: string, checks: KeyFileChecks = {}): Promise<string | null> {
  const platform = checks.platform ?? process.platform;
  const entry = await lstatAsProject(path).catch(() => null);
  if (entry === null) return `${path} is not there.`;
  if (entry.isSymbolicLink()) return `${path} is a symlink.`;
  if (!entry.isFile()) return `${path} is not a file.`;
  if (platform === "win32") return null;
  const uid = "uid" in checks ? checks.uid : process.geteuid?.();
  if (uid !== undefined && entry.uid !== uid) return `${path} belongs to another user.`;
  const mode = entry.mode & 0o777;
  if ((mode & SHARED_BITS) !== 0) return `${path} is mode ${mode.toString(8).padStart(4, "0")}, readable by others.`;
  return null;
}

/** The one-line fix for a refused key file. */
function remedy(path: string, problem: string): string {
  if (problem.endsWith("readable by others.")) return `Run chmod 600 ${path}, then start the server again.`;
  if (problem.endsWith("belongs to another user.")) {
    return `Use a key this account owns: run ${commandName("mcp disconnect")} and ${commandName("mcp connect")} as this user.`;
  }
  return `Run ${commandName("mcp connect")} again to write a new key.`;
}

/** Read a key, refusing one that is not this account's alone. */
export async function readAgentKey(path: string, checks: KeyFileChecks = {}): Promise<AgentPrivateJwk> {
  const problem = await keyFileProblem(path, checks);
  if (problem !== null) {
    throw new PreconditionFailedError({
      message: `The agent key cannot be trusted: ${problem}`,
      action: remedy(path, problem),
      detail: `refused key file ${path}`,
    });
  }
  const parsed = AgentPrivateJwk.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) {
    throw new PreconditionFailedError({
      message: `${path} is not an agent key.`,
      action: `Run ${commandName("mcp connect")} again to write a new key.`,
      detail: z.prettifyError(parsed.error),
    });
  }
  return parsed.data;
}

/** A key file's permission bits, octal (`0600`), or `null` when there is no file — what `pithy mcp status` shows. */
export async function keyFileMode(path: string): Promise<string | null> {
  const entry = await lstatAsProject(path).catch(() => null);
  return entry === null ? null : (entry.mode & 0o777).toString(8).padStart(4, "0");
}

/** Remove a key file. Absent is the end state asked for, not an error. */
export async function removeAgentKey(path: string): Promise<boolean> {
  const entry = await lstatAsProject(path).catch(() => null);
  if (entry === null) return false;
  await rm(path, { force: true });
  return true;
}

/** Import a key for signing. */
export async function importSigningKey(key: AgentPrivateJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { kty: key.kty, crv: key.crv, x: key.x, d: key.d }, "Ed25519", false, ["sign"]);
}

/** Generate an agent's keypair: the private JWK to keep, and the public half to register. */
export async function generateAgentKey(keyId: string): Promise<AgentPrivateJwk> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as { x?: string; d?: string };
  return AgentPrivateJwk.parse({ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d, kid: keyId });
}
