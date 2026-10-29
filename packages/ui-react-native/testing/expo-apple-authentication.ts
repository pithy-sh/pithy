// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createElement, type ReactNode } from "react";
import { singleton } from "./singleton";

export enum AppleAuthenticationScope {
  FULL_NAME = 0,
  EMAIL = 1,
}

export enum AppleAuthenticationButtonType {
  SIGN_IN = 0,
  CONTINUE = 1,
  SIGN_UP = 2,
}

export enum AppleAuthenticationButtonStyle {
  WHITE = 0,
  WHITE_OUTLINE = 1,
  BLACK = 2,
}

/** What a sign-in answers, as far as the kit reads it. */
export interface AppleAuthenticationCredential {
  user: string;
  identityToken: string | null;
  authorizationCode: string | null;
  email: string | null;
  fullName: { givenName: string | null; familyName: string | null } | null;
}

/**
 * `expo-apple-authentication`: `apple.next` is what the next sign-in answers, or the error it throws — Apple's
 * cancellation is an error with `code: "ERR_REQUEST_CANCELED"`.
 */
export const apple = singleton("apple", () => ({
  available: true,
  requests: [] as { requestedScopes?: AppleAuthenticationScope[] }[],
  next: {
    user: "apple-user",
    identityToken: "apple-identity-token",
    authorizationCode: "apple-code",
    email: null,
    fullName: null,
  } as AppleAuthenticationCredential | Error,
  reset(): void {
    this.available = true;
    this.requests = [];
    this.next = {
      user: "apple-user",
      identityToken: "apple-identity-token",
      authorizationCode: "apple-code",
      email: null,
      fullName: null,
    };
  },
}));

export async function isAvailableAsync(): Promise<boolean> {
  return apple.available;
}

export async function signInAsync(
  options: { requestedScopes?: AppleAuthenticationScope[] } = {},
): Promise<AppleAuthenticationCredential> {
  apple.requests.push(options);
  if (apple.next instanceof Error) throw apple.next;
  return apple.next;
}

export function AppleAuthenticationButton(props: { onPress: () => void; testID?: string }): ReactNode {
  return createElement("button", {
    type: "button",
    "data-testid": props.testID ?? "apple-button",
    onClick: props.onPress,
  });
}
