// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Platform } from "react-native";
import * as web from "../templates/src/payments-store";
import * as native from "../templates/src/payments-store.native";

/**
 * Metro's platform extensions, under test: Metro resolves `./payments-store` to `payments-store.native.ts` on a phone
 * and to `payments-store.ts` on the web while it bundles. A test picks the platform by setting `Platform.OS`, so
 * this picks the file on each call.
 */
export type { StoreModule } from "../templates/src/payments-store";

export function loadStore(): ReturnType<typeof web.loadStore> {
  return Platform.OS === "ios" || Platform.OS === "android" ? native.loadStore() : web.loadStore();
}
