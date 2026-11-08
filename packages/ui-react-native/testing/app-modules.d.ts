// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

// The app's own platform files, as the payments-store stand-in imports them. `nativeTestProject` resolves each
// specifier to the file of that name in the app's source directory, which is typed here by the template it was
// copied from.

declare module "virtual:pithy-app/payments-store" {
  export const loadStore: typeof import("../templates/src/payments-store").loadStore;
}

declare module "virtual:pithy-app/payments-store.native" {
  export const loadStore: typeof import("../templates/src/payments-store.native").loadStore;
}
