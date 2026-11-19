// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * Which email sign-in methods this composition offers. A method switched off is never composed, so its routes
 * are Better Auth's 404, its paths leave the OpenAPI document, and no mail is sent for it.
 */
export const SignInMethods = z
  .object({
    magicLink: z
      .boolean()
      .default(true)
      .describe(
        "Whether a link mailed to the address signs it in. When false, `/sign-in/magic-link` and `/magic-link/verify` answer 404. A Microsoft work or school address Entra ID did not verify links by magic link, so it cannot link without it.",
      ),
    emailOtp: z
      .boolean()
      .default(true)
      .describe(
        "Whether a one-time code mailed to the address signs it in. When false, `/email-otp/send-verification-otp` and `/sign-in/email-otp` answer 404.",
      ),
  })
  .describe(
    "The email sign-in methods to offer. Both are on by default. Branch on `compositionEnvironment()` to offer email in one environment only.",
  );
export type SignInMethods = z.output<typeof SignInMethods>;

/** Every email method on: the default, and what an instance built outside a config gets. */
export const ALL_SIGN_IN_METHODS: SignInMethods = { magicLink: true, emailOtp: true };

/** Whether any email method is composed, so every account can reach its own address. */
export function emailSignInComposed(methods: SignInMethods): boolean {
  return methods.magicLink || methods.emailOtp;
}
