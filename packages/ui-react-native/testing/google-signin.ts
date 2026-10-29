// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { singleton } from "./singleton";

/** The error codes the library throws with. */
export const statusCodes = {
  SIGN_IN_CANCELLED: "SIGN_IN_CANCELLED",
  IN_PROGRESS: "IN_PROGRESS",
  PLAY_SERVICES_NOT_AVAILABLE: "PLAY_SERVICES_NOT_AVAILABLE",
  SIGN_IN_REQUIRED: "SIGN_IN_REQUIRED",
} as const;

type SignInResponse =
  | { type: "success"; data: { idToken: string | null; user: { id: string; email: string; name: string | null } } }
  | { type: "cancelled"; data: null };

const SIGNED_IN: SignInResponse = {
  type: "success",
  data: { idToken: "google-id-token", user: { id: "google-user", email: "ada@example.com", name: null } },
};

/**
 * `@react-native-google-signin/google-signin`: `google.next` is what the next sign-in answers, or the error it
 * throws. `google.configured` is what the app configured it with, so a test asserts the web client id.
 */
export const google = singleton("google", () => ({
  configured: null as Record<string, unknown> | null,
  next: SIGNED_IN as SignInResponse | Error,
  reset(): void {
    this.configured = null;
    this.next = SIGNED_IN;
  },
}));

export const GoogleSignin = {
  configure(options: Record<string, unknown>): void {
    google.configured = options;
  },
  async hasPlayServices(): Promise<boolean> {
    return true;
  },
  async signIn(): Promise<SignInResponse> {
    if (google.next instanceof Error) throw google.next;
    return google.next;
  },
  async signOut(): Promise<null> {
    return null;
  },
};

export function isSuccessResponse(response: SignInResponse): response is Extract<SignInResponse, { type: "success" }> {
  return response.type === "success";
}

export function isErrorWithCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}
