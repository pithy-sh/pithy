// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { singleton } from "./singleton";

/** `@react-native-async-storage/async-storage`: a map that outlives a mount the way the device's outlives a launch. */
export const asyncStorage = singleton("asyncStorage", () => ({
  items: new Map<string, string>(),
  reset(): void {
    this.items = new Map();
  },
}));

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return asyncStorage.items.get(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    asyncStorage.items.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    asyncStorage.items.delete(key);
  },
  async clear(): Promise<void> {
    asyncStorage.items.clear();
  },
};

export default AsyncStorage;
