// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { singleton } from "./singleton";

/**
 * `expo-secure-store`, as the native project loads it: the Keychain or the Keystore, kept in a map that outlives a
 * mount the way the real one outlives a launch. `secureStore.failing` makes every call reject, for the paths that
 * must survive a store that refuses. `secureStore.slowWrites` holds every write until it settles, the way the
 * Keychain can take its time.
 */
export const secureStore = singleton("secureStore", () => ({
  items: new Map<string, string>(),
  failing: false,
  slowWrites: null as Promise<void> | null,
  reset(): void {
    this.items = new Map();
    this.failing = false;
    this.slowWrites = null;
  },
}));

function refuse(): Promise<never> {
  return Promise.reject(new Error("The secure store refused."));
}

export async function getItemAsync(key: string): Promise<string | null> {
  if (secureStore.failing) return refuse();
  return secureStore.items.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  if (secureStore.failing) return refuse();
  await secureStore.slowWrites;
  secureStore.items.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  if (secureStore.failing) return refuse();
  secureStore.items.delete(key);
}

export async function isAvailableAsync(): Promise<boolean> {
  return true;
}
