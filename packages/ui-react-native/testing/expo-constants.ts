// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { singleton } from "./singleton";

/** `expo-constants`: the app config Expo served the build, of which the templates read only `extra`. */
export const constants = singleton("constants", () => ({
  expoConfig: { extra: {} as Record<string, unknown> },
  reset(): void {
    this.expoConfig = { extra: {} };
  },
}));

const Constants = {
  get expoConfig(): { extra: Record<string, unknown> } {
    return constants.expoConfig;
  },
};

export default Constants;
