// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { singleton } from "./singleton";

/**
 * `expo-web-browser`: the system browser, as a log of what was opened. `webBrowser.authResult` is what the next
 * `openAuthSessionAsync` answers, so a test plays the provider's redirect back into the app.
 */
export const webBrowser = singleton("webBrowser", () => ({
  opened: [] as string[],
  authSessions: [] as { url: string; redirectUrl: string | null | undefined }[],
  authResult: { type: "cancel" } as { type: "success"; url: string } | { type: "cancel" | "dismiss" },
  reset(): void {
    this.opened = [];
    this.authSessions = [];
    this.authResult = { type: "cancel" };
  },
}));

export async function openBrowserAsync(url: string): Promise<{ type: "opened" }> {
  webBrowser.opened.push(url);
  return { type: "opened" };
}

export async function openAuthSessionAsync(
  url: string,
  redirectUrl?: string | null,
): Promise<{ type: "success"; url: string } | { type: "cancel" | "dismiss" }> {
  webBrowser.authSessions.push({ url, redirectUrl });
  return webBrowser.authResult;
}

export function maybeCompleteAuthSession(): { type: "failed"; message: string } {
  return { type: "failed", message: "Not a web popup." };
}

export function dismissBrowser(): void {}
