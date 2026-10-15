// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { fromZodError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { ensureOwnerOnlyDirFor, tightenMode } from "../../devSecrets/mode";
import { type StatePathOptions, stateDir } from "../../notifier/state";
import { writeFileAtomic } from "../../project/atomic";

/**
 * **A signed-in Cloudflare session: `<config>/session.<profile>.json`, `0600` (#759).**
 *
 * At the config root, beside `cloudflare.json`, and for the reason that file gives: a session is needed
 * at exactly the moment a token is — `pithy init` lists zones before there is a project name to key a
 * directory on — so it cannot live under one. And never inside a checkout, for #145's reason: `npm pack`
 * does not consult `.gitignore` when `files` is set.
 *
 * **Separate from `profiles.json` on purpose.** That file maps directories to profile names and holds
 * nothing secret, so it is `0664` like `dev-ports.json`; this one is a live credential, so it is `0600`
 * like `cloudflare.*.json`. Two postures, two files, and no third posture invented.
 */

/** A profile name: a bare token, because it becomes a file name — the rule `cloudflare.accountName` is held to. */
const PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** No file name has any business being longer. */
const MAX_PROFILE_NAME = 64;

export const ProfileName = z
  .string()
  .max(MAX_PROFILE_NAME, { error: `A profile name is at most ${MAX_PROFILE_NAME} characters.` })
  .regex(PROFILE_NAME_PATTERN, {
    error: (issue) =>
      `A Cloudflare profile name must be a bare token — lowercase letters, digits, and single hyphens, like "pithy". It was ${JSON.stringify(issue.input)}. It becomes the file name <config>/session.<profile>.json.`,
  })
  .describe(
    "The name of a signed-in Cloudflare session — a bare token, because it becomes <config>/session.<profile>.json.",
  );

/** A profile name. Same name as its schema. */
export type ProfileName = z.output<typeof ProfileName>;

export const CloudflareSession = z
  .object({
    profile: ProfileName.describe("The profile this session is stored under."),
    accountId: z.string().min(1).describe("The Cloudflare account this session acts on, discovered at sign-in."),
    accountName: z.string().nullable().describe("The account's name as Cloudflare lists it, for reporting."),
    email: z.string().nullable().describe("The person who signed in, from `GET /user` — the audit actor."),
    accessToken: z.string().min(1).describe("The bearer token. One hour. Never logged, never printed."),
    refreshToken: z
      .string()
      .min(1)
      .nullable()
      .describe("Renews the session without a browser. Rotates on every use, so it is rewritten every refresh."),
    expiresAt: z.iso.datetime().describe("When the access token stops working, ISO-8601."),
    scope: z.string().describe("The scopes granted, space-separated, as the token endpoint said them."),
  })
  .describe("A signed-in Cloudflare session — <config>/session.<profile>.json, mode 0600.");

/** A signed-in Cloudflare session. Same name as its schema. */
export type CloudflareSession = z.output<typeof CloudflareSession>;

/**
 * The session file's name for a profile: `session.<profile>.json`. The name is parsed here because this
 * is the function that turns a string into a file name in the config directory, so it is the one place
 * that must be impossible to reach with an unvalidated one — the rule `cloudflareAccountFile` states.
 */
export function sessionFile(profile: string): string {
  const parsed = ProfileName.safeParse(profile);
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: parsed.error.issues.map((issue) => issue.message).join(" "),
      action: "Name the profile with lowercase letters, digits and hyphens.",
    });
  }
  return `session.${parsed.data}.json`;
}

/** `<config>/session.<profile>.json`. */
export function sessionPath(profile: string, options: StatePathOptions = {}): string {
  return join(stateDir(options), sessionFile(profile));
}

/**
 * The profile's session, or `null` when there is none — or none this kit can read.
 *
 * **Synchronous, because the credential seam is** (`../config.ts`, *load-bearing for the twenty-odd call
 * sites*). A malformed file is no session rather than an error: what it costs is a sign-in, which
 * `pithy cloudflare connect` gives back, and the alternative stops every command in the CLI over a file.
 */
export function readSessionSync(profile: string, options: StatePathOptions = {}): CloudflareSession | null {
  let source: string;
  try {
    source = readFileSync(sessionPath(profile, options), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = CloudflareSession.safeParse(JSON.parse(source));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Write a session, `0600` in the `0700` config directory, atomically — a refresh rewrites it in place, and
 * a reader must see the old session or the new one, never half of each. Narrowed again after the write,
 * for the reason `writeCloudflareConfig` gives.
 */
export async function writeSession(session: CloudflareSession, options: StatePathOptions = {}): Promise<void> {
  const path = sessionPath(session.profile, options);
  await ensureOwnerOnlyDirFor(path);
  await writeFileAtomic(path, `${JSON.stringify(CloudflareSession.parse(session), null, 2)}\n`, { mode: 0o600 });
  await tightenMode(path);
}

/** Delete a profile's session file. `true` when there was one. */
export async function deleteSession(profile: string, options: StatePathOptions = {}): Promise<boolean> {
  try {
    await unlink(sessionPath(profile, options));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Whether the session's access token expires within `marginMs` of `now` — or already has. */
export function sessionExpiresWithin(session: CloudflareSession, marginMs: number, now: Date = new Date()): boolean {
  return Date.parse(session.expiresAt) - now.getTime() <= marginMs;
}
