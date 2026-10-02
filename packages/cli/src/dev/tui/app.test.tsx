// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { render } from "ink-testing-library";
import { describe, expect, test, vi } from "vitest";
import { stripAnsi } from "../logging";
import { DevTui } from "./app";
import { createDevStore } from "./store";

/**
 * **The app: an append-only stream, a pinned footer, and seven keys.**
 *
 * The long-line case below is the one that earns its keep. Ink splits a `<Text>` wider than its
 * container onto a second line, which would put a real newline into the middle of every long wrangler
 * stack trace — breaking copy, and never rejoining when the window widens. A direct
 * `process.stdout.write` lets the *terminal* soft-wrap instead, and preserving that is the whole promise
 * this renderer makes about the stream. #670 has the measurements.
 */

const at = (ms: number) => new Date(1_700_000_000_000 + ms);

const withWorkers = () => {
  const store = createDevStore();
  store.event({ event: "spawned", worker: "api", kind: "app", port: 8787, at: at(0) });
  store.event({ event: "spawned", worker: "web", kind: "app", port: 8788, at: at(0) });
  return store;
};

/** `o` and `l` wait for a worker to be ready, so a case about them has to get it there. */
const upAndReady = () => {
  const store = withWorkers();
  store.event({ event: "ready", worker: "api", at: at(1900) });
  store.event({ event: "ready", worker: "web", at: at(2400) });
  // `l` is dim without somebody to sign in as, which is how the footer dropped its `Dev login:` line.
  store.event({ event: "login", email: "ada@example.com", count: 1 });
  return store;
};

/** Worker output is hidden by default, so a case about the *stream* has to ask for some. */
const showing = () => {
  const store = withWorkers();
  store.reveal("api");
  return store;
};

const handlers = () => ({
  onRestart: vi.fn(),
  onOpen: vi.fn(),
  onLogin: vi.fn(),
  onSignIn: vi.fn(),
  onAutostart: vi.fn(),
  onDigit: vi.fn(),
  onQuit: vi.fn(),
  onInterrupt: vi.fn(),
});

/** Let Ink process a keystroke. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("DevTui — the stream", () => {
  test("committed lines reach the frame", () => {
    const store = showing();
    store.line("[api] Ready on http://localhost:8787", "api");
    const { lastFrame } = render(<DevTui store={store} keys={false} {...handlers()} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("[api] Ready on http://localhost:8787");
  });

  test("a line wider than the terminal arrives in one piece, not split across two", () => {
    const store = showing();
    const long = `[api] Error: ${"segment/".repeat(45)}end`;
    store.line(long, "api");

    const { lastFrame } = render(<DevTui store={store} keys={false} {...handlers()} />);
    const frame = stripAnsi(lastFrame() ?? "");

    // Verbatim, on one line. If Ink wrapped it, the string is present only with a newline inside it.
    expect(frame).toContain(long);
    expect(frame.split("\n").some((l) => l.includes(long))).toBe(true);
  });

  test("ANSI the worker wrote survives — the terminal keeps the color wrangler chose", () => {
    const store = showing();
    store.line("\x1b[32m[api]\x1b[39m Ready", "api");
    const { lastFrame } = render(<DevTui store={store} keys={false} {...handlers()} />);
    expect(lastFrame() ?? "").toContain("\x1b[32m[api]\x1b[39m Ready");
  });
});

describe("DevTui — keys", () => {
  test("r restarts the selected worker", async () => {
    const store = withWorkers();
    const h = handlers();
    const { stdin } = render(<DevTui store={store} keys={true} {...h} />);
    stdin.write("r");
    await tick();
    expect(h.onRestart).toHaveBeenCalledWith("api");
  });

  test("the arrow keys move the selection, so r acts on a different worker", async () => {
    const store = withWorkers();
    const h = handlers();
    const { stdin } = render(<DevTui store={store} keys={true} {...h} />);
    stdin.write("\u001B[B"); // down
    await tick();
    stdin.write("r");
    await tick();
    expect(h.onRestart).toHaveBeenCalledWith("web");
  });

  test("a digit goes to the identity list, never to the roster", async () => {
    // `pithy seed` can mint several signed-in identities and `l` numbers them (#667), so a digit is
    // already an answer to a question the session asked. The roster moves on the arrows alone.
    const store = withWorkers();
    const h = handlers();
    const { stdin } = render(<DevTui store={store} keys={true} {...h} />);
    stdin.write("2");
    await tick();

    expect(h.onDigit).toHaveBeenCalledWith("2");
    expect(store.state().selected).toBe(0);
    stdin.write("r");
    await tick();
    expect(h.onRestart).toHaveBeenCalledWith("api");
  });

  test("f shows the selected worker's output, and f again stops it", async () => {
    const store = withWorkers();
    const { stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("f");
    await tick();
    expect(store.state().revealed).toEqual(["api"]);
    stdin.write("f");
    await tick();
    expect(store.state().revealed).toEqual([]);
  });

  test("f acts on the row you are on, so several front ends can each be shown", async () => {
    // An app stack can carry more than one UI, so revealing is per worker and additive rather than a
    // single exclusive focus.
    const store = withWorkers();
    const { stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("f");
    await tick();
    stdin.write("\u001B[B");
    await tick();
    stdin.write("f");
    await tick();
    expect(store.state().revealed).toEqual(["api", "web"]);
  });

  test("F shows every worker, and F again returns to quiet", async () => {
    // `f` is this worker's output and `F` is everyone's — one pair, and the shift is the "all". `a` is
    // autostart now, which is what the column is called.
    const store = withWorkers();
    const { stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("F");
    await tick();
    expect(store.state().showingAll).toBe(true);
    stdin.write("F");
    await tick();
    expect(store.state().showingAll).toBe(false);
    expect(store.state().revealed).toEqual([]);
  });

  test("worker output is hidden until asked for, so the roster is what you see first", async () => {
    const store = withWorkers();
    store.line("[api] GET /health 200", "api");
    const { lastFrame } = render(<DevTui store={store} keys={true} {...handlers()} />);
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("GET /health");
  });

  test("l asks for the dev login", async () => {
    const h = handlers();
    const { stdin } = render(<DevTui store={upAndReady()} keys={true} {...h} />);
    stdin.write("l");
    await tick();
    expect(h.onLogin).toHaveBeenCalled();
  });

  test("q quits", async () => {
    const h = handlers();
    const { stdin } = render(<DevTui store={withWorkers()} keys={true} {...h} />);
    stdin.write("q");
    await tick();
    expect(h.onQuit).toHaveBeenCalled();
  });

  test("Ctrl-C goes to the supervisor's own shutdown, never to Ink's exit", async () => {
    // Ink is rendered with exitOnCtrlC: false by `startTui`. If Ink unmounted and exited first, every
    // wrangler → workerd subtree would be orphaned — the condition `pithy dev`'s lsof sweep exists to
    // clean up after.
    const h = handlers();
    const { stdin } = render(<DevTui store={withWorkers()} keys={true} {...h} />);
    stdin.write("\u0003");
    await tick();
    expect(h.onInterrupt).toHaveBeenCalled();
    expect(h.onQuit).not.toHaveBeenCalled();
  });

  test("no keyboard means no key bar and no handler ever fires", async () => {
    // `pithy dev < /dev/null`: the roster is still worth rendering, and there is nothing to press it with.
    const store = withWorkers();
    const h = handlers();
    const { lastFrame } = render(<DevTui store={store} keys={false} {...h} />);
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("q quit");
  });
});

describe("DevTui — a parked worker", () => {
  const withParked = () => {
    const store = createDevStore();
    store.event({
      event: "roster",
      members: [
        { worker: "dash-board", kind: "app", port: 8787, starts: true, autostart: true },
        { worker: "payments", kind: "host", port: 8789, starts: false, autostart: false },
      ],
      at: at(0),
    });
    return store;
  };

  test("the roster lists it, so there is a row to act on", () => {
    const { lastFrame } = render(<DevTui store={withParked()} keys={true} {...handlers()} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("payments");
    expect(frame).toContain("skipped");
  });

  test("r on a parked row reads start, because that is what it does", async () => {
    const store = withParked();
    const { lastFrame, stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("\u001B[B");
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("r start");
  });

  test("r on a parked worker asks for it to be started", async () => {
    const store = withParked();
    const h = handlers();
    const { stdin } = render(<DevTui store={store} keys={true} {...h} />);
    stdin.write("\u001B[B");
    await tick();
    stdin.write("r");
    await tick();
    expect(h.onRestart).toHaveBeenCalledWith("payments");
  });

  test("open, login and logs stay on the bar when they do not apply — dimmed, not hidden", async () => {
    // The dim/plain split itself is `keyBarSegments`' contract and is asserted there; this is the half
    // only a render can answer, which is that a key the row cannot do is still *shown*. The suite runs
    // with `NO_COLOR=1` (vitest.config.ts), so the frame carries words rather than escape sequences.
    const store = withParked();
    const { lastFrame, stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("\u001B[B");
    await tick();
    const frame = stripAnsi(lastFrame() ?? "");
    // On a parked row the logs slot is `F`'s alone: `f` has no started worker to act on, and a merged
    // segment dimmed on its behalf would have claimed neither key worked.
    for (const label of ["r start", "o open", "l login", "F all logs"]) expect(frame).toContain(label);
  });
});

describe("DevTui — the identity picker", () => {
  const withPicker = () => {
    const store = withWorkers();
    store.openPicker(
      Array.from({ length: 29 }, (_, i) => ({ userId: `dev-${i + 1}`, email: `user${i + 1}@example.com` })),
      "api",
    );
    return store;
  };

  test("it replaces the roster while it is open", () => {
    const store = withPicker();
    const out = stripAnsi(render(<DevTui store={store} keys={true} {...handlers()} />).lastFrame() ?? "");
    expect(out).toContain("Sign in as");
    expect(out).not.toContain("8787");
  });

  test("the arrows move the marker", async () => {
    const store = withPicker();
    const { stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("\u001B[B");
    await tick();
    expect(store.state().picker?.selected).toBe(1);
  });

  test("typing filters, and signs nobody in", async () => {
    const store = withPicker();
    const h = handlers();
    const { stdin } = render(<DevTui store={store} keys={true} {...h} />);
    stdin.write("user2");
    await tick();
    expect(store.state().picker?.query).toBe("user2");
    expect(h.onSignIn).not.toHaveBeenCalled();
  });

  test("a digit is filter text, not a jump — an email contains digits", async () => {
    const store = withPicker();
    const { stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("7");
    await tick();
    expect(store.state().picker?.query).toBe("7");
    expect(store.state().picker?.selected).toBe(0);
  });

  test("backspace takes a character back", async () => {
    const store = withPicker();
    const { stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("ab");
    await tick();
    stdin.write("\u007F");
    await tick();
    expect(store.state().picker?.query).toBe("a");
  });

  test("esc clears a query before it closes anything", async () => {
    const store = withPicker();
    const { stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("user");
    await tick();
    stdin.write("\u001B");
    await tick();
    expect(store.state().picker).not.toBeNull();
    expect(store.state().picker?.query).toBe("");
    stdin.write("\u001B");
    await tick();
    expect(store.state().picker).toBeNull();
  });

  test("Enter signs in as the marked row of the *filtered* list", async () => {
    const store = withPicker();
    const h = handlers();
    const { stdin } = render(<DevTui store={store} keys={true} {...h} />);
    stdin.write("user25");
    await tick();
    stdin.write("\r");
    await tick();
    expect(h.onSignIn).toHaveBeenCalledWith("dev-25", "api");
  });

  test("Enter signs in as the marked identity, on the worker l was pressed on", async () => {
    const store = withPicker();
    const h = handlers();
    const { stdin } = render(<DevTui store={store} keys={true} {...h} />);
    stdin.write("\u001B[B");
    await tick();
    stdin.write("\r");
    await tick();
    expect(h.onSignIn).toHaveBeenCalledWith("dev-2", "api");
  });

  test("and the roster comes back", async () => {
    const store = withPicker();
    const { stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("\r");
    await tick();
    expect(store.state().picker).toBeNull();
  });

  test("esc cancels and signs nobody in", async () => {
    const store = withPicker();
    const h = handlers();
    const { stdin } = render(<DevTui store={store} keys={true} {...h} />);
    stdin.write("\u001B");
    await tick();
    expect(store.state().picker).toBeNull();
    expect(h.onSignIn).not.toHaveBeenCalled();
  });

  test("the roster's verbs are inert while the question is open", async () => {
    // `q` especially: tearing the session down in answer to "who shall I sign in as" would be absurd.
    const store = withPicker();
    const h = handlers();
    const { stdin } = render(<DevTui store={store} keys={true} {...h} />);
    for (const key of ["r", "o", "f", "F", "a", "q", "l"]) {
      stdin.write(key);
      await tick();
    }
    expect(h.onRestart).not.toHaveBeenCalled();
    expect(h.onOpen).not.toHaveBeenCalled();
    expect(h.onQuit).not.toHaveBeenCalled();
    expect(store.state().picker).not.toBeNull();
  });

  test("Ctrl-C still stops the session, even mid-question", async () => {
    const store = withPicker();
    const h = handlers();
    const { stdin } = render(<DevTui store={store} keys={true} {...h} />);
    stdin.write("\u0003");
    await tick();
    expect(h.onInterrupt).toHaveBeenCalled();
  });
});

describe("DevTui — open and login wait for ready", () => {
  test("o and l stay on the bar while a worker builds — dimmed, not hidden", () => {
    // Opening a worker that has not bound its port gives a connection error, and signing into one gives
    // a dead route. With a front end that can take a long time (#674), "started" is not "usable".
    // The dim/plain split is `keyBarSegments`' contract; this asserts the keys are still *shown*, and the
    // case below asserts they do nothing. The spinner glyph is deliberately not asserted — its frame is
    // a function of the wall clock.
    const out = stripAnsi(render(<DevTui store={withWorkers()} keys={true} {...handlers()} />).lastFrame() ?? "");
    expect(out).toContain("building");
    expect(out).toContain("o open");
    expect(out).toContain("l login");
    // `f` and `F` share one slot: this worker started, so the slot is `f`'s and names `F` beside it.
    expect(out).toContain("f logs (F all)");
  });

  test("and pressing them does nothing — dim means inert, not merely drawn dim", async () => {
    // `o` was drawn dim on a worker it could not open and opened it anyway. The bar and the handler read
    // one value now.
    const h = handlers();
    const { stdin } = render(<DevTui store={withWorkers()} keys={true} {...h} />);
    stdin.write("o");
    await tick();
    stdin.write("l");
    await tick();
    expect(h.onOpen).not.toHaveBeenCalled();
    expect(h.onLogin).not.toHaveBeenCalled();
  });

  test("both work the moment the worker is ready", async () => {
    const h = handlers();
    const { stdin } = render(<DevTui store={upAndReady()} keys={true} {...h} />);
    stdin.write("o");
    await tick();
    expect(h.onOpen).toHaveBeenCalledWith("api");
  });

  test("r stays available while building, because that is when you need it most", async () => {
    // A `wrangler dev` whose first build failed never rebuilds. Waiting for `ready` to allow a restart
    // would disable the one key that fixes the one state it cannot leave.
    const h = handlers();
    const { stdin } = render(<DevTui store={withWorkers()} keys={true} {...h} />);
    stdin.write("r");
    await tick();
    expect(h.onRestart).toHaveBeenCalledWith("api");
  });

  test("f stays available too — output is how you find out why it is not ready", async () => {
    const store = withWorkers();
    const { stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("f");
    await tick();
    expect(store.state().revealed).toEqual(["api"]);
  });
});

describe("DevTui — autostart from the roster", () => {
  const roster = (autostart: boolean) => {
    const store = createDevStore();
    store.event({
      event: "roster",
      members: [{ worker: "payments", kind: "host", port: 8789, starts: true, autostart }],
      at: at(0),
    });
    return store;
  };

  test("a turns autostart off on the selected worker", async () => {
    const h = handlers();
    const { stdin } = render(<DevTui store={roster(true)} keys={true} {...h} />);
    stdin.write("a");
    await tick();
    expect(h.onAutostart).toHaveBeenCalledWith("payments", false);
  });

  test("and back on again", async () => {
    const h = handlers();
    const { stdin } = render(<DevTui store={roster(false)} keys={true} {...h} />);
    stdin.write("a");
    await tick();
    expect(h.onAutostart).toHaveBeenCalledWith("payments", true);
  });

  test("the bar names the state it is moving to, not the one it is in", () => {
    expect(stripAnsi(render(<DevTui store={roster(true)} keys={true} {...handlers()} />).lastFrame() ?? "")).toContain(
      "a autostart off",
    );
    expect(stripAnsi(render(<DevTui store={roster(false)} keys={true} {...handlers()} />).lastFrame() ?? "")).toContain(
      "a autostart on",
    );
  });

  test("the row says on or off, under a header that names the column", () => {
    const out = stripAnsi(render(<DevTui store={roster(false)} keys={true} {...handlers()} />).lastFrame() ?? "");
    expect(out).toContain("autostart");
    expect(out).toContain("off");
  });

  test("a row with autostart off says so, even while the worker is running", async () => {
    // `p` changes the next run, so `ready` and `parked` are both true until the session ends. Hiding
    // either would be a lie about what is in front of you.
    const store = roster(false);
    store.event({ event: "ready", worker: "payments", at: at(1000) });
    store.event({ event: "autostart", worker: "payments", autostart: false });
    const out = stripAnsi(render(<DevTui store={store} keys={true} {...handlers()} />).lastFrame() ?? "");
    expect(out).toContain("ready");
    expect(out).toContain("off");
  });

  test("a works on a worker that is still building, since it is not about this run", async () => {
    const h = handlers();
    const { stdin } = render(<DevTui store={roster(true)} keys={true} {...h} />);
    stdin.write("a");
    await tick();
    expect(h.onAutostart).toHaveBeenCalled();
  });
});

describe("DevTui — login is not gated on a seed snapshot", () => {
  test("l fires even when the session started with nothing seeded", async () => {
    // **The regression this pins.** The `login` event is raised once, before anything spawns, so its
    // count is a snapshot — and gating the key on it, with a dimmed key being genuinely inert, made `l`
    // dead for the life of any session that started unseeded. `pithy seed` in a second terminal, press
    // `l`, nothing. That is the reported bug, reintroduced from the other end.
    const store = withWorkers();
    store.event({ event: "ready", worker: "api", at: at(1900) });
    const h = handlers();
    const { stdin } = render(<DevTui store={store} keys={true} {...h} />);
    stdin.write("l");
    await tick();
    expect(h.onLogin).toHaveBeenCalledWith("api");
  });

  test("and fires with one seeded too", async () => {
    const h = handlers();
    const { stdin } = render(<DevTui store={upAndReady()} keys={true} {...h} />);
    stdin.write("l");
    await tick();
    expect(h.onLogin).toHaveBeenCalledWith("api");
  });

  test("the supervisor answers, not the key: a worker that is not ready still refuses", async () => {
    // `l` waits for `ready` because the dev-login route is not served until the Worker is up. That gate
    // is about the worker, not about the seed.
    const h = handlers();
    const { stdin } = render(<DevTui store={withWorkers()} keys={true} {...h} />);
    stdin.write("l");
    await tick();
    expect(h.onLogin).not.toHaveBeenCalled();
  });
});

describe("DevTui — the logs keys share one slot", () => {
  test("a started worker's row offers f, naming F beside it", () => {
    const out = stripAnsi(render(<DevTui store={withWorkers()} keys={true} {...handlers()} />).lastFrame() ?? "");
    expect(out).toContain("f logs (F all)");
    expect(out).not.toContain("F all logs");
  });

  test("a parked row offers F alone, because f does not apply there", () => {
    // Merging them into one dimmed segment would have said neither worked, when `F` does — and a key the
    // bar draws dim is a key that does nothing.
    const store = createDevStore();
    store.event({
      event: "roster",
      members: [{ worker: "payments", kind: "host", port: 8791, starts: false, autostart: false }],
      at: at(0),
    });
    const out = stripAnsi(render(<DevTui store={store} keys={true} {...handlers()} />).lastFrame() ?? "");
    expect(out).toContain("F all logs");
    expect(out).not.toContain("f logs");
  });

  test("both keys still work on a started row", async () => {
    const store = withWorkers();
    const { stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("f");
    await tick();
    expect(store.state().revealed).toEqual(["api"]);
    stdin.write("F");
    await tick();
    expect(store.state().showingAll).toBe(true);
  });

  test("and F still works on a parked row, where f does not", async () => {
    const store = createDevStore();
    store.event({
      event: "roster",
      members: [{ worker: "payments", kind: "host", port: 8791, starts: false, autostart: false }],
      at: at(0),
    });
    const { stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("f");
    await tick();
    expect(store.state().revealed).toEqual([]);
    stdin.write("F");
    await tick();
    expect(store.state().showingAll).toBe(true);
  });
});

describe("DevTui — the keys the bar promises", () => {
  test("? prints the key list, which a collapsed bar is the only hint for", async () => {
    // `keyBarSegments` falls back to `? keys` on a narrow terminal and the docs name `?` as the key
    // list — and there was no case for it, so the one key a collapsed bar offered did nothing.
    const store = upAndReady();
    const { stdin } = render(<DevTui store={store} keys={true} {...handlers()} />);
    stdin.write("?");
    await tick();

    const committed = store.state().lines.map((l) => stripAnsi(l.text));
    expect(committed.some((l) => l.includes("keys"))).toBe(true);
    for (const key of ["r", "o", "f", "F", "a", "l", "q"]) {
      expect(committed.some((l) => l.trimStart().startsWith(`${key} `))).toBe(true);
    }
  });

  test("a multi-character chunk is not forwarded as a digit", async () => {
    // Ink delivers a paste or a fast sequence as one `input`, and `"12" >= "1" && "12" <= "9"` is true —
    // so the chunk reached `pickIdentity`, matched nothing, and consumed the list `l` had just offered.
    const h = handlers();
    const { stdin } = render(<DevTui store={upAndReady()} keys={true} {...h} />);
    stdin.write("12");
    await tick();
    expect(h.onDigit).not.toHaveBeenCalled();
  });

  test("a single digit still reaches the identity list", async () => {
    const h = handlers();
    const { stdin } = render(<DevTui store={upAndReady()} keys={true} {...h} />);
    stdin.write("2");
    await tick();
    expect(h.onDigit).toHaveBeenCalledWith("2");
  });
});
