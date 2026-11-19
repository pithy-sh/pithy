// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/** The email sign-in methods a Worker composed, as its auth projection carries them. */
export interface EmailMethods {
  /** Whether a link mailed to the address signs it in. */
  readonly magicLink: boolean;
  /** Whether a one-time code mailed to the address signs it in. */
  readonly emailOtp: boolean;
}

/** How a sign-in screen offers email: a mailed link, a mailed code, or not at all. */
export type EmailWay = "link" | "code" | null;

/**
 * The one way a sign-in screen offers email, from the methods the Worker composed.
 *
 * A link wins where it is composed and can come back to this screen. `linkReturns` is false on a phone with no
 * universal link, because the Worker hands a magic link off only to an https link. A code is next, and with
 * neither the screen offers no email at all. Absent `methods` is a projection from before the field existed, and
 * reads as both composed.
 */
export function emailWay(methods: EmailMethods | undefined, linkReturns = true): EmailWay {
  const composed = methods ?? { magicLink: true, emailOtp: true };
  if (composed.magicLink && linkReturns) return "link";
  if (composed.emailOtp) return "code";
  return null;
}
