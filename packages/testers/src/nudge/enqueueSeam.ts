// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { EnqueueNudge } from "./send";

/**
 * The email enqueue seam, loaded from the project's own install.
 *
 * A guarded dynamic import: a project can compose testers without email — inviting nobody and simply
 * tracking a roster it imported — and the pass should still advance state and write its snapshot rather
 * than fail on a dependency it does not strictly need.
 *
 * **Its own module, away from `worker.ts`, because of the clock.** The instant this seam stamps on an
 * email job is a *liveness* value, not a stamp: `createdAt` is what the email scheduler's grace re-drive
 * reads to decide a `pending` job never dispatched. The whole of pithy-sh/pithy#328 is that the pass's
 * other clock — the one deciding the day key — must be journalled and this one must not, and a rule
 * about a clock that lives in a module no test can import is a rule nothing holds anybody to.
 */

/** The bindings this seam needs from the worker's env. `TestersWorkerEnv` supplies them. */
export interface NudgeEnqueueEnv {
  /** The app database, which holds `pithy_email_jobs` beside the testers tables. */
  DB: D1Database;
  /** The sending identity, copied from the email capability's resolved config at provision. */
  EMAIL_FROM_ADDRESS?: string;
  EMAIL_FROM_NAME?: string;
  /** The resolved email theme, as the email worker carries it. */
  EMAIL_THEME?: string;
  /**
   * The project's message catalogs as one JSON var, exactly as the email host worker carries them.
   *
   * The **shell** is what this moves — the document's `lang` and `dir`, the footer's opt-out word. A
   * nudge's own words are the adopter's copy, supplied per message and never in a catalog, so a
   * translated tester email is only as translated as the copy somebody wrote for it. This capability
   * holds no per-tester locale to choose with either: a roster is a list of addresses, and inventing a
   * language for one of them would be worse than the honest English. So the catalogs are threaded and
   * the tag is not, and the day a member row carries one, this is already the seam it renders through.
   */
  [catalogVar: `EMAIL_MESSAGES_${string}`]: unknown;
  /** The email send Workflow, so an immediate job dispatches now rather than waiting for a cron tick. */
  EMAIL_SENDER?: { create(options: { params: { jobIds: string[] } }): Promise<unknown> };
}

/**
 * Build the enqueue seam, or `undefined` when this deployment cannot send.
 *
 * **`clock` is a thunk, and it is read once per enqueued nudge.** That is the liveness half of
 * pithy-sh/pithy#328 and it is load-bearing, not tidiness. `enqueueEmail` writes the clock it is given
 * as the job's `createdAt`, and the email scheduler re-drives any `pending` job whose `createdAt` is
 * older than `graceMs` — on the assumption that its dispatch died. A nudge enqueued under an instant
 * the pass read minutes or hours ago is therefore born already past that cutoff, so the scheduler
 * claims and dispatches it while the `EMAIL_SENDER.create` this function just made is still running.
 * Two send Workflows, one job, and `runSend` short-circuits only a job already `sent`. That is a
 * double-send, and it is why the pass's journalled instant must never reach this line.
 */
export async function buildNudgeEnqueue(
  env: NudgeEnqueueEnv,
  clock: () => Date = () => new Date(),
): Promise<EnqueueNudge | undefined> {
  // No sending identity means no send. Falling back to a plausible-looking default address would mail
  // the adopter's testers from a domain their DKIM does not cover, which is worse than sending nothing:
  // it trains the recipients' providers to treat the real domain as spam.
  if (!env.EMAIL_FROM_ADDRESS || !env.EMAIL_FROM_NAME) return undefined;

  try {
    const { enqueueEmail } = await import("@pithy-sh/email/src/send/enqueue");
    const { emailDatabase } = await import("@pithy-sh/email/src/data/tables");
    const { defaultTheme, EmailTheme } = await import("@pithy-sh/email/src/templates/theme");
    const { catalogLayers, catalogsFromEnv } = await import("@pithy-sh/email/src/templates/messages");
    const theme = env.EMAIL_THEME ? EmailTheme.parse(JSON.parse(env.EMAIL_THEME)) : defaultTheme;
    // One variable per locale, collected and validated by the same seam the email host uses.
    const layersFor = catalogLayers(catalogsFromEnv(env as unknown as Record<string, unknown>));
    const fromAddress = env.EMAIL_FROM_ADDRESS;
    const fromName = env.EMAIL_FROM_NAME;
    return async (input) =>
      enqueueEmail(
        {
          db: emailDatabase(env.DB),
          fromAddress,
          fromName,
          theme,
          layersFor,
          sender: env.EMAIL_SENDER,
          // Read here, per nudge — see the note above. Hoisting this out of the closure is the
          // double-send.
          now: clock(),
          newId: () => crypto.randomUUID(),
        },
        input,
      );
  } catch {
    return undefined;
  }
}
