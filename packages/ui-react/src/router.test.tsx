// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test } from "vitest";
import {
  comparePatterns,
  matchPath,
  matchPattern,
  navigate,
  type PathParameters,
  Router,
  replace,
  type ScreenProps,
  updateSearch,
  useSearch,
  useSearchParam,
} from "../templates/src/router";

/**
 * The scaffolded router's path matching (#291).
 *
 * The three exported functions are the whole of the rule, and they are pure over strings, so they are
 * exercised directly — a rule about ambiguity wants twenty cases, and twenty renders would be twenty
 * assertions about React.
 *
 * `Router` is then rendered twice, because the wiring around the rule changed too: the table is a
 * pattern list beside a map rather than one map keyed on the path.
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

/**
 * The route table wired up for real, against the template tree's own screens.
 *
 * The pure functions above are the rule; this is the wiring around them — the table is now a pattern
 * list beside a map rather than one map, and a mistake there is not reachable from a string. Two paths
 * are enough: one the glob really answers, and one nothing does.
 */
describe("Router", () => {
  // React refuses `act` unless the environment says it is a test one, the same as `signIn.test.tsx`.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  /** Render the router at `path`, waiting out the suspended route table. */
  async function renderAt(path: string): Promise<string> {
    window.history.pushState(null, "", path);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Router />);
    });
    // The route table is a promise the router suspends on, and it settles only once every route module
    // has been imported. Waiting for the fallback to go is what says "resolved" without reaching into a
    // module-private promise; the deadline is a real failure rather than a silent assertion on the
    // fallback's own text.
    const deadline = Date.now() + 10_000;
    while (container.innerHTML.includes("One moment.")) {
      if (Date.now() > deadline) throw new Error("the route table never resolved");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      });
    }
    const html = container.innerHTML;
    await act(async () => {
      root.unmount();
    });
    container.remove();
    return html;
  }

  test("a path no pattern answers gets the not-found screen", async () => {
    expect(await renderAt("/nothing-answers-this")).toContain("Not here.");
  }, 20_000);

  test("a scaffolded screen still renders, and is handed its (empty) params", async () => {
    // `/otp` declares no parameter, so this is the case every existing screen is in.
    const html = await renderAt("/otp");
    expect(html).toContain("Enter the code.");
    expect(html).not.toContain("Not here.");
  }, 20_000);
});

/**
 * The history layer: what a screen reads out of the address bar, and what it writes back (#409).
 *
 * These are exercised against the real `window.history`, not a stub, because every one of the
 * decisions under test is about the history stack — whether an entry was pushed or swapped, and
 * whether a repeat write pushes a second copy of a URL the reader is already on. A stub would assert
 * the stub.
 *
 * The probe prints both readers, bracketed, so a re-render is visible as text: `[?email=ada][ada]`.
 */
describe("the query string", () => {
  // React refuses `act` unless the environment says it is a test one, as above.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  /** Both readers, side by side. `(absent)` is how `null` shows up in the text. */
  function Probe(props: { name: string }): string {
    const search = useSearch();
    const value = useSearchParam(props.name);
    return `[${search}][${value === null ? "(absent)" : value}]`;
  }

  /** Mount the probe at `url`, and hand back its text plus the two things a case does to it. */
  async function mountAt(url: string, name = "email") {
    window.history.pushState(null, "", url);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe name={name} />);
    });
    return {
      text: (): string => container.textContent ?? "",
      /** Run a writer inside `act`, so the re-render it causes has happened by the next assertion. */
      async run(change: () => void): Promise<void> {
        await act(async () => {
          change();
        });
      },
      async stop(): Promise<void> {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      },
    };
  }

  test("useSearch hands back the query verbatim, and an empty string when there is none", async () => {
    const withQuery = await mountAt("/probe?email=ada%40example.com&kind=users");
    expect(withQuery.text()).toBe("[?email=ada%40example.com&kind=users][ada@example.com]");
    await withQuery.stop();

    // Not `"?"`. This is the value the dedupe guard compares against, so the empty case is the one
    // every hand-rolled writer gets wrong.
    const without = await mountAt("/probe");
    expect(without.text()).toBe("[][(absent)]");
    await without.stop();
  });

  test("useSearchParam decodes the value, and is null for a key nobody sent", async () => {
    const probe = await mountAt("/probe?email=ada+lovelace%40example.com&kind=users", "email");
    expect(probe.text()).toBe("[?email=ada+lovelace%40example.com&kind=users][ada lovelace@example.com]");
    await probe.run(() => {
      updateSearch({ email: null });
    });
    expect(probe.text()).toBe("[?kind=users][(absent)]");
    await probe.stop();
  });

  test("both readers re-render on navigate, replace, updateSearch, and a browser Back", async () => {
    const probe = await mountAt("/probe?email=ada");
    expect(probe.text()).toBe("[?email=ada][ada]");

    await probe.run(() => {
      navigate("/probe?email=grace");
    });
    expect(probe.text()).toBe("[?email=grace][grace]");

    await probe.run(() => {
      updateSearch({ kind: "users" });
    });
    expect(probe.text()).toBe("[?email=grace&kind=users][grace]");

    await probe.run(() => {
      replace("/probe?email=hedy");
    });
    expect(probe.text()).toBe("[?email=hedy][hedy]");

    await probe.run(() => {
      window.history.back();
    });
    expect(probe.text()).toBe("[?email=grace][grace]");

    await probe.run(() => {
      window.history.forward();
    });
    expect(probe.text()).toBe("[?email=hedy][hedy]");
    await probe.stop();
  });

  test("replace swaps the current entry, so Back skips the URL it replaced", async () => {
    const probe = await mountAt("/replace-a");
    await probe.run(() => {
      navigate("/replace-b");
    });
    const entries = window.history.length;

    await probe.run(() => {
      replace("/replace-c");
    });
    expect(window.location.pathname).toBe("/replace-c");
    // The correction took the entry rather than adding one. This is the whole of what `replace` is for.
    expect(window.history.length).toBe(entries);

    await probe.run(() => {
      window.history.back();
    });
    expect(window.location.pathname).toBe("/replace-a");
    await probe.stop();
  });

  test("replace is a no-op on the URL it is already at, matching navigate's guard", async () => {
    const probe = await mountAt("/replace-guard?email=ada");
    // The marker is what makes this discriminating. `replaceState` to the URL you are already on moves
    // no entry and changes no location, so neither `history.length` nor `pathname + search` can tell a
    // guarded call from an unguarded one — both would still hold with the guard deleted. The entry's
    // *state* is the one thing a same-URL `replaceState` does touch: it would swap this object for the
    // `null` the writer passes.
    window.history.replaceState({ marker: "kept" }, "", "/replace-guard?email=ada");
    const entries = window.history.length;
    await probe.run(() => {
      replace("/replace-guard?email=ada");
    });
    expect(window.history.state).toEqual({ marker: "kept" });
    expect(window.history.length).toBe(entries);
    expect(window.location.pathname + window.location.search).toBe("/replace-guard?email=ada");
    await probe.stop();
  });

  test("updateSearch sets, clears, and leaves the parameters it was not asked about alone", async () => {
    const probe = await mountAt("/patch?kind=users&id=usr_9f2c", "kind");
    await probe.run(() => {
      updateSearch({ id: "usr_1a4b" });
    });
    expect(window.location.search).toBe("?kind=users&id=usr_1a4b");

    await probe.run(() => {
      updateSearch({ id: null });
    });
    expect(window.location.search).toBe("?kind=users");
    expect(probe.text()).toBe("[?kind=users][users]");
    await probe.stop();
  });

  test("clearing the last parameter leaves no `?`, so writing it again pushes nothing", async () => {
    const probe = await mountAt("/patch-empty?kind=users", "kind");
    await probe.run(() => {
      updateSearch({ kind: null });
    });
    // Not `"/patch-empty?"`. A bare `?` is a URL the dedupe guard can never match, so every repeat
    // call would push another entry and Back would walk through them without the page changing.
    expect(window.location.href.endsWith("/patch-empty")).toBe(true);
    expect(window.location.search).toBe("");

    const entries = window.history.length;
    await probe.run(() => {
      updateSearch({ kind: null });
    });
    expect(window.history.length).toBe(entries);
    await probe.stop();
  });

  test("updateSearch leaves the pathname and the hash where they were", async () => {
    const probe = await mountAt("/patch-hash?kind=users#section", "kind");
    await probe.run(() => {
      updateSearch({ id: "usr_9f2c" });
    });
    expect(window.location.pathname).toBe("/patch-hash");
    expect(window.location.hash).toBe("#section");
    expect(window.location.search).toBe("?kind=users&id=usr_9f2c");

    // And the no-op holds with a hash present, where the guard on `pathname + search` cannot help.
    const entries = window.history.length;
    await probe.run(() => {
      updateSearch({ id: "usr_9f2c" });
    });
    expect(window.history.length).toBe(entries);
    expect(window.location.hash).toBe("#section");
    await probe.stop();
  });

  test("updateSearch pushes by default and swaps the entry when asked to replace", async () => {
    const probe = await mountAt("/patch-mode");
    const entries = window.history.length;
    await probe.run(() => {
      updateSearch({ kind: "users" });
    });
    expect(window.history.length).toBe(entries + 1);

    await probe.run(() => {
      updateSearch({ id: "usr_9f2c" }, { replace: true });
    });
    expect(window.location.search).toBe("?kind=users&id=usr_9f2c");
    expect(window.history.length).toBe(entries + 1);

    // Back therefore lands before the pushed one, not on the corrected copy of it.
    await probe.run(() => {
      window.history.back();
    });
    expect(window.location.search).toBe("");
    await probe.stop();
  });
});

/**
 * The typing, asserted by the compiler.
 *
 * These are types, not values: nothing here runs, and `tsconfig.templates.json` is what checks them —
 * a wrong name is a build failure in this package. That is the acceptance criterion "a screen reading
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
