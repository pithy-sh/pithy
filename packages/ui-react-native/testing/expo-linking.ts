// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { singleton } from "./singleton";

/** `expo-linking`: the app's own scheme, and a log of the links it was asked to open. */
export const linking = singleton("linking", () => ({
  scheme: "pithyapp",
  opened: [] as string[],
  reset(): void {
    this.scheme = "pithyapp";
    this.opened = [];
  },
}));

export function createURL(path: string, options?: { queryParams?: Record<string, string> }): string {
  const trimmed = path.replace(/^\/+/, "");
  const query = options?.queryParams
    ? Object.entries(options.queryParams)
        .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
        .join("&")
    : "";
  return `${linking.scheme}://${trimmed}${query === "" ? "" : `?${query}`}`;
}

export async function openURL(url: string): Promise<true> {
  linking.opened.push(url);
  return true;
}

export async function canOpenURL(): Promise<boolean> {
  return true;
}

export async function getInitialURL(): Promise<string | null> {
  return null;
}

export function addEventListener(): { remove: () => void } {
  return { remove: () => undefined };
}
