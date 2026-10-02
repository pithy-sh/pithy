// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { chooseRenderer, interruptAction, rendererInputsFromProcess, ticking } from "./choose";

/**
 * **Which renderer a run gets, decided in one place and from explicit inputs.**
 *
 * The decision is four environment facts and a flag, and every one of them has been a source of bugs in
 * somebody's CLI: a TTY check that forgot `--json`, a CI run that rendered escape sequences into a build
 * log, a `TERM=dumb` editor shell that got a repainting footer. So it is a pure function over its inputs
 * rather than five reads of `process` scattered down a command body, and each clause has a test that
 * fails if it is dropped.
 *
 * It imports nothing from Ink, deliberately: this module sits on `pithy dev`'s static graph, and the
 * renderer it names is loaded behind `await import` so no other command pays for React
 * (`ci/lazyHeavyImports.test.ts`).
 */

/** Everything true, which is the one combination that yields the footer. */
const interactive = {
  stdoutIsTTY: true,
  stdinIsTTY: true,
  json: false,
  ci: false,
  term: "xterm-256color",
  noTui: undefined,
  tui: true,
};

describe("chooseRenderer", () => {
  test("an interactive terminal gets the footer, with keys", () => {
    expect(chooseRenderer(interactive)).toEqual({ tui: true, keys: true });
  });

  test("--json is plain, whatever the terminal is", () => {
    // Every command is agent-drivable and a machine reads exactly one line per event. A footer would
    // interleave frames with the stream a consumer is parsing.
    expect(chooseRenderer({ ...interactive, json: true })).toEqual({ tui: false, keys: false });
  });

  test("a piped stdout is plain", () => {
    expect(chooseRenderer({ ...interactive, stdoutIsTTY: false })).toEqual({ tui: false, keys: false });
  });

  test("CI is plain even when a TTY is attached", () => {
    // A CI log is precisely what docs/CLI.md §3.1 protects, and some runners do allocate a pty.
    expect(chooseRenderer({ ...interactive, ci: true })).toEqual({ tui: false, keys: false });
  });

  test("TERM=dumb is plain — it is the terminal saying it cannot do this", () => {
    expect(chooseRenderer({ ...interactive, term: "dumb" })).toEqual({ tui: false, keys: false });
  });

  test("an absent TERM is not treated as dumb", () => {
    // A missing TERM is an unknown terminal, not a declared-incapable one, and a TTY is still a TTY.
    expect(chooseRenderer({ ...interactive, term: undefined })).toEqual({ tui: true, keys: true });
  });

  test("PITHY_NO_TUI turns the footer off for any non-blank value", () => {
    expect(chooseRenderer({ ...interactive, noTui: "1" })).toEqual({ tui: false, keys: false });
    expect(chooseRenderer({ ...interactive, noTui: "yes" })).toEqual({ tui: false, keys: false });
  });

  test("PITHY_NO_TUI set but empty is not set — the house rule CI and PITHY_OFFLINE follow", () => {
    expect(chooseRenderer({ ...interactive, noTui: "" })).toEqual({ tui: true, keys: true });
  });

  test("a TTY stdout with a redirected stdin gets the footer and no keys", () => {
    // `pithy dev < /dev/null`. The roster is still worth rendering; there is nothing to press it with,
    // and the dev-login line prints the URL instead — which `devLoginLines` already does on this fact.
    expect(chooseRenderer({ ...interactive, stdinIsTTY: false })).toEqual({ tui: true, keys: false });
  });

  test("keys are never claimed on the plain path", () => {
    // The plain path has its own reader in `terminal/keys.ts`; this flag is the TUI's, and reporting it
    // true alongside `tui: false` would hand raw mode to two owners.
    expect(chooseRenderer({ ...interactive, json: true, stdinIsTTY: true }).keys).toBe(false);
  });
});

/**
 * The reads themselves. Thin, but six values threaded in one place: a `TERM` landing where `PITHY_NO_TUI`
 * belongs would make the escape hatch a no-op and nothing else would notice.
 */
describe("rendererInputsFromProcess", () => {
  test("threads the environment the predicate asks about", () => {
    vi.stubEnv("TERM", "xterm-kitty");
    vi.stubEnv("PITHY_NO_TUI", "1");
    vi.stubEnv("CI", "");
    try {
      const inputs = rendererInputsFromProcess(false);
      expect(inputs.term).toBe("xterm-kitty");
      expect(inputs.noTui).toBe("1");
      expect(inputs.ci).toBe(false);
      expect(inputs.json).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("reports CI from any non-blank CI, which is what forces the plain stream in a build", () => {
    vi.stubEnv("CI", "woodpecker");
    try {
      expect(rendererInputsFromProcess(false).ci).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("carries --json through, since it is the term that outranks a terminal", () => {
    expect(rendererInputsFromProcess(true).json).toBe(true);
  });

  test("reads both streams' isTTY, not one of them twice", () => {
    const out = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const inp = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      expect(rendererInputsFromProcess(false)).toMatchObject({ stdoutIsTTY: true, stdinIsTTY: false });
    } finally {
      if (out) Object.defineProperty(process.stdout, "isTTY", out);
      if (inp) Object.defineProperty(process.stdin, "isTTY", inp);
    }
  });
});

describe("chooseRenderer — the --tui flag", () => {
  test("--no-tui is plain, on the best terminal there is", () => {
    expect(chooseRenderer({ ...interactive, tui: false })).toEqual({ tui: false, keys: false });
  });

  test("the default is the footer, so nobody has to ask for it", () => {
    expect(chooseRenderer({ ...interactive, tui: true })).toEqual({ tui: true, keys: true });
  });

  test("PITHY_NO_TUI still suppresses it when the flag was not typed", () => {
    // A standing preference in a profile, which is what the variable is for.
    expect(chooseRenderer({ ...interactive, noTui: "1" })).toEqual({ tui: false, keys: false });
  });

  test("but a typed --tui beats the variable", () => {
    // The same reading `--app` takes over this branch's autostart answer: naming it outright is the more
    // specific act, so one run can override a profile without editing it.
    expect(chooseRenderer({ ...interactive, noTui: "1", tui: true, tuiExplicit: true })).toEqual({
      tui: true,
      keys: true,
    });
  });

  test("and --no-tui wins over a typed --tui, because it cannot be both", () => {
    expect(chooseRenderer({ ...interactive, tui: false, tuiExplicit: true })).toEqual({ tui: false, keys: false });
  });

  test("no flag overrides a pipe, --json, CI or TERM=dumb", () => {
    // `--tui` into a pipe is not a preference, it is a mistake: there is no terminal to draw on, and the
    // stream is what a consumer parses.
    for (const absolute of [{ stdoutIsTTY: false }, { json: true }, { ci: true }, { term: "dumb" }]) {
      expect(chooseRenderer({ ...interactive, ...absolute, tui: true, tuiExplicit: true })).toEqual({
        tui: false,
        keys: false,
      });
    }
  });
});

describe("ticking", () => {
  test("a building worker keeps the footer repainting", () => {
    expect(ticking([{ status: "building" }])).toBe(true);
  });

  test("so does a waiting one — it is the row whose elapsed matters most", () => {
    // `reduceSession` moves a late worker from `building` to `waiting` and never back, so leaving
    // `waiting` out froze the elapsed on exactly the worrying row once nothing else was building.
    expect(ticking([{ status: "ready" }, { status: "waiting" }])).toBe(true);
  });

  test("a quiet session stops repainting", () => {
    expect(ticking([{ status: "ready" }, { status: "exited" }, { status: "skipped" }])).toBe(false);
  });

  test("an empty roster is quiet", () => {
    expect(ticking([])).toBe(false);
  });
});

describe("interruptAction", () => {
  test("the ordinary press asks the supervisor to shut down", () => {
    expect(interruptAction({ hasSession: true, stopping: false })).toBe("shutdown");
  });

  test("a second press stops waiting for it", () => {
    expect(interruptAction({ hasSession: true, stopping: true })).toBe("exit");
  });

  test("a press before the session exists exits on the first one", () => {
    // The footer mounts before `startDev` resolves, so this press used to reach a handle that did not
    // exist: it did nothing, and only a second press hard-exited. There is nothing to ask politely.
    expect(interruptAction({ hasSession: false, stopping: false })).toBe("exit");
  });

  test("and still exits if it is pressed again", () => {
    expect(interruptAction({ hasSession: false, stopping: true })).toBe("exit");
  });
});
