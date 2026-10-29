// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, test } from "vitest";
import {
  navigate,
  Router,
  replace,
  routeTable,
  updateSearch,
  useSearch,
  useSearchParam,
} from "../templates/src/router";

/**
 * The route table wired up for real, against the template tree's own screens.
 *
 * The matching rule is `@pithy-sh/ui-core/src/routes`, tested there; this is the wiring around it — the table is a
 * pattern list beside a map, and a mistake there is not reachable from a string. Two paths
 * are enough: one the glob really answers, and one nothing does.
 */
describe("Router", () => {
  // React refuses `act` unless the environment says it is a test one, the same as `signIn.test.tsx`.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // The table settles only once every template screen has been imported, and whichever test rendered
  // first paid for that inside its own 10s deadline. Beside the rest of this package's files on a busy
  // machine, the import alone outran it: six runs in eight failed (#641). Loaded once here, with room,
  // so the deadline below measures the router. `routeTable()` caches one promise, so every render
  // reuses exactly this table.
  beforeAll(async () => {
    await routeTable();
  }, 120_000);

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
