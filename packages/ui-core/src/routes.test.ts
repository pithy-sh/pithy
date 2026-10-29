// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  buildRoutes,
  comparePatterns,
  matchPath,
  matchPattern,
  type PathParameters,
  type RouteModule,
  type ScreenProps,
  type ScreenRole,
  screenPath,
} from "./routes";

/**
 * Path matching and the role lookup, which every router binding shares.
 *
 * The three matching functions are the whole of the rule, and they are pure over strings, so they are exercised
 * directly: a rule about ambiguity wants twenty cases, and twenty renders would be twenty assertions about React.
 *
 * The typing half is checked by the compiler, not by an assertion — see the bottom of this file.
 */

describe("matchPattern", () => {
  test("a static pattern matches its own path and nothing else", () => {
    expect(matchPattern("/sign-in", "/sign-in")).toEqual({});
    expect(matchPattern("/sign-in", "/sign-up")).toBeNull();
    expect(matchPattern("/", "/")).toEqual({});
  });

  test("a parameter captures its segment", () => {
    expect(matchPattern("/invitations/:token", "/invitations/abc123")).toEqual({ token: "abc123" });
  });

  test("several parameters each capture their own", () => {
    expect(matchPattern("/orgs/:org/members/:id", "/orgs/acme/members/42")).toEqual({ org: "acme", id: "42" });
  });

  test("segment counts must agree, so nothing swallows a tail", () => {
    expect(matchPattern("/invitations/:token", "/invitations")).toBeNull();
    expect(matchPattern("/invitations/:token", "/invitations/abc/extra")).toBeNull();
    expect(matchPattern("/invitations", "/invitations/abc")).toBeNull();
  });

  test("a parameter captures at least one character", () => {
    // The trailing slash is the case this exists for: it would otherwise yield an empty token.
    expect(matchPattern("/invitations/:token", "/invitations/")).toBeNull();
    expect(matchPattern("/:a/:b", "//")).toBeNull();
  });

  test("values are decoded, once", () => {
    expect(matchPattern("/u/:name", "/u/ada%20lovelace")).toEqual({ name: "ada lovelace" });
    // Decoded once and not twice: the value the sender encoded was itself a percent sign.
    expect(matchPattern("/u/:name", "/u/a%2520b")).toEqual({ name: "a%20b" });
    // Split before decode, so an encoded slash stays inside one value.
    expect(matchPattern("/files/:key", "/files/a%2Fb")).toEqual({ key: "a/b" });
  });

  test("a malformed encoding does not match", () => {
    expect(matchPattern("/invitations/:token", "/invitations/%zz")).toBeNull();
    expect(matchPattern("/invitations/:token", "/invitations/%E0%A4%A")).toBeNull();
  });

  test("a static segment is never decoded, so it is compared as declared", () => {
    // `/a b` reaches the router as `/a%20b`, and a pattern declaring the space is not that path.
    expect(matchPattern("/a b", "/a%20b")).toBeNull();
  });

  test("a bare colon names nothing and is a literal", () => {
    expect(matchPattern("/:", "/:")).toEqual({});
    expect(matchPattern("/:", "/anything")).toBeNull();
  });
});

describe("comparePatterns", () => {
  test("static beats dynamic at the leftmost segment where they differ", () => {
    expect(comparePatterns("/invitations/new", "/invitations/:token")).toBeLessThan(0);
    expect(comparePatterns("/invitations/:token", "/invitations/new")).toBeGreaterThan(0);
    expect(comparePatterns("/orders/:id/receipt", "/orders/:id/:view")).toBeLessThan(0);
  });

  test("the leftmost difference decides, not the count of static segments", () => {
    // The right-hand pattern is static in two later positions and still loses on the first.
    expect(comparePatterns("/orders/:a/:b", "/:x/receipt/print")).toBeLessThan(0);
  });

  test("two patterns of the same shape order by their text, so the answer is never the glob's", () => {
    expect(comparePatterns("/a/:x", "/a/:y")).toBeLessThan(0);
    expect(comparePatterns("/a/:y", "/a/:x")).toBeGreaterThan(0);
    expect(comparePatterns("/a/:x", "/a/:x")).toBe(0);
  });
});

describe("matchPath", () => {
  /** A table with the ambiguity the rule exists for, plus a couple of ordinary screens. */
  const PATTERNS = ["/", "/sign-in", "/invitations/new", "/invitations/:token", "/orgs/:org/members/:id"];

  test("a static route wins over a dynamic one at the same position", () => {
    expect(matchPath(PATTERNS, "/invitations/new")).toEqual({ pattern: "/invitations/new", params: {} });
  });

  test("the dynamic route answers everything else at that position", () => {
    expect(matchPath(PATTERNS, "/invitations/abc123")).toEqual({
      pattern: "/invitations/:token",
      params: { token: "abc123" },
    });
  });

  test("the winner does not depend on the order the patterns arrive in", () => {
    // The point of the whole comparator: registration order is two globs, and nobody can read it.
    for (const order of [PATTERNS, [...PATTERNS].reverse(), [...PATTERNS].sort()]) {
      expect(matchPath(order, "/invitations/new")?.pattern).toBe("/invitations/new");
      expect(matchPath(order, "/invitations/abc")?.pattern).toBe("/invitations/:token");
    }
  });

  test("nothing matching is null, which is the not-found screen", () => {
    expect(matchPath(PATTERNS, "/nowhere")).toBeNull();
    expect(matchPath(PATTERNS, "/invitations")).toBeNull();
    expect(matchPath([], "/")).toBeNull();
  });

  test("an ordinary static table still answers exactly", () => {
    expect(matchPath(PATTERNS, "/sign-in")).toEqual({ pattern: "/sign-in", params: {} });
    expect(matchPath(PATTERNS, "/")).toEqual({ pattern: "/", params: {} });
  });
});

describe("screenPath", () => {
  /** A screen in the shape a route module declares: a path, a role, and a component. */
  function screen(path: string, role: ScreenRole): () => Promise<RouteModule> {
    return async () => ({ path, role, default: () => null });
  }

  test("answers the path the screen claiming the role declares", async () => {
    const table = await buildRoutes([screen("/canary-sign-in", "sign-in"), screen("/canary-paywall", "paywall")]);
    expect(screenPath(table, "sign-in")).toBe("/canary-sign-in");
    expect(screenPath(table, "paywall")).toBe("/canary-paywall");
  });

  test("a later loader takes a role and a pattern over, so an app's screen wins", async () => {
    const table = await buildRoutes([screen("/kit", "sign-in"), screen("/mine", "sign-in"), screen("/kit", "paywall")]);
    expect(screenPath(table, "sign-in")).toBe("/mine");
    expect(table.patterns).toEqual(["/kit", "/mine"]);
  });

  test("a module that declares no path is not a route", async () => {
    const table = await buildRoutes([async () => ({ default: () => null }) as unknown as RouteModule]);
    expect(table.patterns).toEqual([]);
  });

  test("a role no screen claims throws, naming the export to add", async () => {
    const table = await buildRoutes([]);
    expect(() => screenPath(table, "paywall")).toThrow(/export const role = "paywall"/);
  });
});

/**
 * The typing, asserted by the compiler.
 *
 * These are types, not values: nothing here runs, and `bun run typecheck` is what checks them — a wrong
 * name is a typecheck failure in this package. That is the acceptance criterion "a screen reading
 * `params.tokne` should not compile", stated as a thing that fails rather than as prose.
 */
type Assert<T extends true> = T;
type Equals<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

type _OneParameter = Assert<Equals<PathParameters<"/invitations/:token">, { readonly token: string }>>;
type _TwoParameters = Assert<
  Equals<PathParameters<"/orgs/:org/members/:id">, { readonly org: string; readonly id: string }>
>;
type _MiddleParameter = Assert<Equals<PathParameters<"/orders/:id/receipt">, { readonly id: string }>>;
type _NoParameters = Assert<Equals<PathParameters<"/sign-in">, Readonly<Record<never, string>>>>;

/** A screen, written the way `ScreenProps` documents. The names it may read are the ones it declared. */
const path = "/invitations/:token";
function Invitation({ params }: ScreenProps<typeof path>): string {
  // @ts-expect-error the name is `token`; a typo is a compile error, which is the whole point
  params.tokne;
  return params.token;
}

test("a screen reads the parameter its own path declares", () => {
  expect(Invitation({ params: { token: "abc" } })).toBe("abc");
});
