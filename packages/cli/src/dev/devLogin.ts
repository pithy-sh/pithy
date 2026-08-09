// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEV_LOGIN_PATH, DEV_LOGIN_ROUTE, DevLogin } from "@pithy-sh/core/src/seed/devLogin";

/**
 * The `pithy dev` end of the dev login: say that there is one, and how to use it — **without ever
 * saying what it is**.
 *
 * The banner is still where this belongs, because it is the only place a developer reliably looks and a
 * seeded session nobody discovers has removed no friction. What changed is what the banner is allowed to
 * carry. It used to hand over the credential itself:
 *
 * ```
 * document.cookie = "better-auth.session_token=…; path=/; max-age=31535918"
 * ```
 *
 * A working session cookie, rendered as text, on every `pithy dev`. Terminals scroll back, output gets
 * tee'd and piped, screenshots get pasted into issues — a value printed once is a value at rest in
 * places nobody chose. `core/src/seed/seed.ts` already treats the login artifact as sensitive for
 * exactly this reason, so printing it was the one place the rule was suspended by design.
 *
 * Now the credential travels over HTTP, from the Worker to the browser, and the terminal carries a
 * keypress and a URL. Neither is a secret: {@link DEV_LOGIN_ROUTE} is registered only in a `dev`
 * composition that is not CI, and it hands out only what `pithy seed` already minted on this machine.
 *
 * **A cookie value must never appear in a string this module returns.** That is asserted directly, over
 * every line every function here can produce, rather than trusted to review.
 */

/** A started worker the dev-login route can be opened on — one that composes auth. */
export interface DevLoginTarget {
  /** The worker's name, as `pithy dev` labels it. */
  name: string;
  /** Its localhost origin, from the pinned port. */
  origin: string;
}

/** What the banner needs to know about the session it is describing. */
export interface DevLoginBanner {
  /** Whether a keypress can be offered — a TTY that is not being piped, and not `--json`. */
  interactive: boolean;
  /** The started workers that carry the route. Empty is a real answer, and gets its own sentence. */
  targets: readonly DevLoginTarget[];
  /**
   * Whether this run is under CI, where the capability refuses to register the route at all.
   *
   * The keypress follows the route. Offering `l` here would be offering a 404, and it is the *only*
   * refusal `pithy dev` can see coming: every other one is about what is running.
   */
  ci: boolean;
}

/** The one sentence for a run under CI. Stated once, because the banner and the keypress both say it. */
const CI_REFUSAL = "the dev-login route is not registered under CI.";

/** What pressing `l` should do: open this URL, and say these lines. Either half may be empty. */
export interface DevLoginKeyAction {
  /** The URL to open, or `undefined` when there is nothing to open — never a URL that would 404. */
  url?: string;
  /** What to print. A refusal always says what to do about it; an open says what it is opening. */
  lines: string[];
}

/** Read the seeded dev login, or `undefined` when there is none. Validated — an unreadable file is no login. */
export async function readDevLogin(projectDir: string): Promise<DevLogin | undefined> {
  try {
    const parsed = DevLogin.safeParse(JSON.parse(await readFile(join(projectDir, DEV_LOGIN_PATH), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Where a worker serves the dev login. The route is core's, so both ends spell it the same way once. */
export function devLoginUrl(origin: string): string {
  return `${origin}${DEV_LOGIN_ROUTE}`;
}

/**
 * A usable login, or `undefined`.
 *
 * An expired cookie is worse than no cookie: it looks like a way in, fails silently in the browser, and
 * sends someone hunting for a bug in auth. The banner therefore treats expiry as absence; the keypress
 * does not, because someone who pressed `l` asked a question and deserves the reason.
 */
function usable(login: DevLogin | undefined, now: Date): DevLogin | undefined {
  if (!login) return undefined;
  return login.expiresAt.getTime() > now.getTime() ? login : undefined;
}

/** One indented `name: url` line per target — the shape both the banner and the keypress list choices in. */
function choices(targets: readonly DevLoginTarget[]): string[] {
  return targets.map((target) => `  ${target.name}: ${devLoginUrl(target.origin)}`);
}

/**
 * The banner lines for a seeded dev login — empty when there is none, and empty when it has expired.
 *
 * Four shapes, because the honest sentence differs: a keypress where there is a keypress and one target,
 * a URL where there is not, the choices where more than one worker composes auth, and a plain statement
 * where nothing running carries the route at all. Nothing here guesses.
 */
export function devLoginLines(login: DevLogin | undefined, now: Date, banner: DevLoginBanner): string[] {
  const live = usable(login, now);
  if (!live) return [];
  if (banner.ci) return [`Dev login: ${live.email} — ${CI_REFUSAL}`];
  const targets = banner.targets;

  if (targets.length === 0) {
    return [`Dev login: ${live.email} — no running worker composes auth, so there is nothing to open.`];
  }
  if (banner.interactive) {
    const verb = targets.length === 1 ? "open a signed-in browser" : "choose a worker and open a signed-in browser";
    return [`Dev login: ${live.email} — press l to ${verb}.`];
  }
  const first = targets[0];
  if (targets.length === 1 && first) {
    return [`Dev login: ${live.email} — open ${devLoginUrl(first.origin)} to sign in.`];
  }
  return [`Dev login: ${live.email} — open one of these to sign in.`, ...choices(targets)];
}

/**
 * What `l` does, decided without touching the terminal or the network so it can be tested as a value.
 *
 * Every refusal names the command that fixes it and opens nothing. A browser sent to a route that 404s
 * is worse than a sentence: it looks like the feature is broken rather than like the session is missing.
 */
export function devLoginKeyAction(
  login: DevLogin | undefined,
  now: Date,
  targets: readonly DevLoginTarget[],
  ci = false,
): DevLoginKeyAction {
  if (!login) return { lines: ["No dev login is seeded. Run pithy seed, then press l again."] };
  if (!usable(login, now)) {
    return { lines: ["The seeded dev login has expired. Run pithy seed to mint a fresh one."] };
  }
  // Before the targets, because this refusal is about the route rather than about what is running: the
  // workers below all compose auth and none of them mounted it.
  if (ci) return { lines: [`Not opening — ${CI_REFUSAL}`] };
  if (targets.length === 0) return { lines: ["No running worker composes auth, so there is nothing to open."] };

  const first = targets[0];
  if (targets.length === 1 && first) {
    const url = devLoginUrl(first.origin);
    return { url, lines: [`Opening ${url} as ${login.email}.`] };
  }
  // More than one worker carries the route, and they are separate origins — a cookie set on one signs
  // nobody into the other. There is no defensible guess, so the choice is printed.
  return { lines: ["More than one worker composes auth. Open the one you want:", ...choices(targets)] };
}
