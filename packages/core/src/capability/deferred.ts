// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context, MiddlewareHandler, Next } from "hono";
import type { CapabilitySettings } from "./settings";

/**
 * **Work a Worker does on first use, not at startup.**
 *
 * Each helper takes a loader, `() => import("./bounce/handler").then((m) => m.handler)`, and calls it on the
 * first call it sees. The module behind the loader is evaluated then, with everything it imports, so a
 * capability's handlers, middleware and seams cost nothing until a request or an event reaches them. Every
 * loader runs once, however many calls arrive while it is loading, and a load that fails is tried again on
 * the next call.
 */

/** A value built on its first use and shared by every later caller. A build that fails is tried again. */
export function deferredValue<T>(build: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= build().catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
}

/** A function whose implementation is imported on its first call. It answers asynchronously, whatever the loaded one does. */
export function deferred<A extends unknown[], R>(
  load: () => Promise<(...args: A) => R | Promise<R>>,
): (...args: A) => Promise<R> {
  const loaded = deferredValue(load);
  return async (...args) => (await loaded())(...args);
}

/** A Hono middleware handler of whatever shape the loaded module exports, typed by the app it was written for. */
type LoadedMiddleware = (c: never, next: Next) => unknown;

/** A middleware whose handler is imported on the first request that reaches it, and run in its place. */
export function deferredMiddleware(load: () => Promise<LoadedMiddleware>): MiddlewareHandler {
  const loaded = deferredValue(load);
  return async (c: Context, next: Next) => {
    const handler = await loaded();
    const res = await handler(c as never, next);
    return res instanceof Response ? res : undefined;
  };
}

/**
 * A capability's settings checks, imported on the first check `pithy doctor` runs. Whether there is an
 * account half is said up front, since a caller reads its presence before calling it.
 */
export function deferredSettings(
  load: () => Promise<CapabilitySettings>,
  { account }: { readonly account: boolean },
): CapabilitySettings {
  const loaded = deferredValue(load);
  return {
    local: async (context) => (await loaded()).local(context),
    ...(account
      ? {
          account: async (context) => {
            const checks = await loaded();
            return checks.account ? checks.account(context) : [];
          },
        }
      : {}),
  };
}
