// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEV_LOGIN_PATH, DevLogin } from "@pithy-sh/core/src/seed/devLogin";

/**
 * The `pithy dev` end of the dev login: read what the seed wrote, and say how to use it.
 *
 * It goes on the ready banner because that is the only place a developer reliably looks. A capability that
 * mints a session nobody discovers has solved nothing — the friction being removed here is "sign in before
 * you can look at anything", and a doc is not where that friction is felt.
 */

/** Read the seeded dev login, or `undefined` when there is none. Validated — an unreadable file is no login. */
export async function readDevLogin(projectDir: string): Promise<DevLogin | undefined> {
  try {
    const parsed = DevLogin.safeParse(JSON.parse(await readFile(join(projectDir, DEV_LOGIN_PATH), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The banner lines for a seeded dev login — empty when there is none, and empty when it has expired.
 *
 * An expired cookie is worse than no cookie: it looks like a way in, fails silently in the browser, and
 * sends someone hunting for a bug in auth. Reseeding mints a fresh one, so saying nothing is the honest
 * answer. The line handed over is a console paste rather than a URL, because Pithy ships no sign-in page to
 * point at and a cookie is what the browser actually needs.
 */
export function devLoginLines(login: DevLogin | undefined, now: Date): string[] {
  if (!login) return [];
  const maxAge = Math.floor((login.expiresAt.getTime() - now.getTime()) / 1000);
  if (maxAge <= 0) return [];
  return [
    `Dev login: ${login.email}. Paste into the browser console, then reload.`,
    `document.cookie = "${login.cookieName}=${login.cookieValue}; path=/; max-age=${maxAge}"`,
  ];
}
