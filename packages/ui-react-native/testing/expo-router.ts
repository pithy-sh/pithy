// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createElement, type ReactNode, useSyncExternalStore } from "react";
import { singleton } from "./singleton";

/**
 * `expo-router`, as far as the kit's router binding reads it: the current pathname, the current query, and an
 * imperative push and replace. A history of every navigation is kept, so a test asserts where the app went and how.
 */
interface Place {
  pathname: string;
  params: Record<string, string | string[]>;
}

const listeners = singleton("expoRouterListeners", () => new Set<() => void>());

function parse(href: string): Place {
  const [pathname = "/", query = ""] = href.split("?");
  const params: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const [name = "", value = ""] = pair.split("=");
    params[decodeURIComponent(name)] = decodeURIComponent(value.replace(/\+/g, " "));
  }
  return { pathname, params };
}

export const expoRouter = singleton("expoRouter", () => ({
  place: parse("/") as Place,
  history: [] as { kind: "push" | "replace"; href: string }[],
  /** Land on `href` the way a deep link would: no history entry the app made. */
  visit(href: string): void {
    this.place = parse(href);
    for (const listener of listeners) listener();
  },
  reset(): void {
    this.place = parse("/");
    this.history = [];
  },
}));

function go(kind: "push" | "replace", href: string): void {
  expoRouter.history.push({ kind, href });
  expoRouter.visit(href);
}

export const router = {
  push: (href: string) => go("push", href),
  navigate: (href: string) => go("push", href),
  replace: (href: string) => go("replace", href),
  back: () => undefined,
  canGoBack: () => false,
};

function usePlace(): Place {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => expoRouter.place,
  );
}

export function usePathname(): string {
  return usePlace().pathname;
}

export function useGlobalSearchParams(): Record<string, string | string[]> {
  return usePlace().params;
}

export function useLocalSearchParams(): Record<string, string | string[]> {
  return usePlace().params;
}

export function useRouter(): typeof router {
  return router;
}

export function Slot(): ReactNode {
  return null;
}

export function Stack(props: { children?: ReactNode }): ReactNode {
  return createElement("div", null, props.children);
}
