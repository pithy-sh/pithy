// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEV_LOGIN_CLAIM_PARAM,
  DEV_LOGIN_ROUTE,
  DevLogin,
  devLoginFileFor,
  SEED_ARTIFACT_DIR,
} from "@pithy-sh/core/src/seed/devLogin";

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
 * Now the session travels over HTTP, from the Worker to the browser, and the terminal carries a keypress.
 *
 * ## The claim, and the one place it is unavoidable — `#572`
 *
 * The URL carries a signed claim naming the user to sign in as, because the seed writes a file and a
 * Worker has no filesystem to read it from. **That claim is a credential**: presenting it to a `dev`
 * composition mints a session. So it is kept out of printed output wherever the CLI can open the browser
 * itself, which is every interactive run with one worker — the ordinary case, where nothing is printed
 * but a name.
 *
 * It cannot be kept out of the rest. A non-interactive run has no keypress, and a run with two workers
 * has no defensible guess about which one to open, so both must print a link a person can click — and a
 * link that omitted the claim would 404. {@link claimIsPrinted} names those cases in one place so the
 * test can assert the boundary rather than the wording.
 *
 * **A session cookie must still never appear in a string this module returns**, and neither must the
 * claim in any line outside that boundary. Both are asserted directly, over every line every function
 * here can produce, rather than trusted to review.
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

/**
 * Read the seeded dev login, or `undefined` when there is none. Validated — an unreadable file is no login.
 *
 * `dev`'s by default, which is what `pithy dev` reads. Another environment's is its own file (#643): a feature's
 * is `dev-login.feature.json`, and `pithy seed --env feature` reads that one and never dev's.
 */
export async function readDevLogin(projectDir: string, env = "dev"): Promise<DevLogin | undefined> {
  try {
    const path = join(projectDir, SEED_ARTIFACT_DIR, devLoginFileFor(env));
    const parsed = DevLogin.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a worker serves the dev login, carrying the claim that says who to sign in as.
 *
 * The route and the parameter are both core's, so both ends spell them the same way once. **The claim
 * travels in the URL because the artifact is a file and a Worker has no filesystem — `#572`.** It used
 * to need nothing: the route found the one seeded session in D1. That session is what the product's own
 * sign-out revoked, which is the whole of the bug this replaced.
 */
export function devLoginUrl(origin: string, claim: string): string {
  return `${origin}${DEV_LOGIN_ROUTE}?${DEV_LOGIN_CLAIM_PARAM}=${claim}`;
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

/**
 * Whether a claim has to be printed, for one surface and one shape of run.
 *
 * **The two surfaces differ, and a single predicate hid that.** The banner prints a link only when there
 * is no keypress to offer instead — with a terminal it says *press l* and names no URL, however many
 * workers are running. The keypress prints links only when there is more than one worker, because with
 * one it opens the browser itself and with several there is no defensible guess.
 *
 * Stated here rather than at the call sites so the boundary is a thing a test can assert and a reader
 * can find. True means a person has to click a link themselves, and the claim rides in it; false means
 * the terminal sees a name and nothing else.
 */
export function claimIsPrinted(where: "banner" | "keypress", interactive: boolean, targets: number): boolean {
  return where === "banner" ? targets > 0 && !interactive : targets > 1;
}

/** One indented `name: url` line per target — the shape both the banner and the keypress list choices in. */
function choices(targets: readonly DevLoginTarget[], claim: string): string[] {
  return targets.map((target) => `  ${target.name}: ${devLoginUrl(target.origin, claim)}`);
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
    return [`Dev login: ${live.email} — open ${devLoginUrl(first.origin, live.claim)} to sign in.`];
  }
  return [`Dev login: ${live.email} — open one of these to sign in.`, ...choices(targets, live.claim)];
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
    // **The URL is opened, not printed.** It carries the claim, and this is the path where the CLI can
    // hand it to a browser without it passing through a terminal somebody tees, pastes or screenshots.
    return { url: devLoginUrl(first.origin, login.claim), lines: [`Opening the dev login for ${login.email}.`] };
  }
  // More than one worker carries the route, and they are separate origins — a cookie set on one signs
  // nobody into the other. There is no defensible guess, so the choice is printed.
  return { lines: ["More than one worker composes auth. Open the one you want:", ...choices(targets, login.claim)] };
}

/**
 * **What `pithy seed` says about a login it just minted off `dev` (#643).** One line, with the link over the
 * origin the login was minted for — a feature deployment's `workers.dev` origin — so a person has a URL to open.
 *
 * The claim is in that URL, as it is in `pithy dev`'s non-interactive banner: the URL is the one place it has to
 * be. With no origin there is nothing to open it on, and the line says so rather than inventing one.
 */
export function seededLoginLines(login: DevLogin | undefined, now: Date): string[] {
  const live = usable(login, now);
  if (!live) return [];
  if (live.origin === undefined) {
    return [`Dev login: ${live.email} — this environment has no address to open it on. Pass --host.`];
  }
  return [`Dev login: ${live.email} — open ${devLoginUrl(live.origin, live.claim)} to sign in.`];
}
