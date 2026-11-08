// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/// <reference path="./app-modules.d.ts" />

import * as web from "virtual:pithy-app/payments-store";
import * as native from "virtual:pithy-app/payments-store.native";
import { Platform } from "react-native";

/**
 * Metro's platform extensions, under test: Metro resolves `./payments-store` to `payments-store.native.ts` on a phone
 * and to `payments-store.ts` on the web while it bundles. A test picks the platform by setting `Platform.OS`, so
 * this picks the file on each call. Both are the app's own copies, which `nativeTestProject` resolves from the
 * app's source directory.
 */
export type { StoreModule } from "../templates/src/payments-store";

export function loadStore(): ReturnType<typeof web.loadStore> {
  return Platform.OS === "ios" || Platform.OS === "android" ? native.loadStore() : web.loadStore();
}
