// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { devTuiHarness, harnessEnv } from "../../test-utils/devTuiHarness";
import { NO_WRAP } from "./app";

/**
 * **What the footer does to a real terminal — measured, on one, with the real component.**
 *
 * Every other test of this renderer uses `ink-testing-library`, which is the right seam for *what the
 * component decides* and can say nothing about *what a terminal receives*. The claims below are only the
 * second kind, and each of them is load-bearing for #670:
 *
 * 1. **Committed lines survive verbatim**, in order, each exactly once — the property that makes the
 *    stream byte-identical to a plain run and keeps the terminal's own scroll and copy working.
 * 2. **A line longer than the terminal is not split.** Ink wraps a `<Text>` against its container, which
 *    would put a real newline inside every long wrangler stack trace: it would stop copying as one line
 *    and never rejoin when the window widened, because a soft wrap belongs to the terminal and a hard one
 *    to us. `wrap` cannot prevent it — `truncate` keeps only the first terminal-width characters and
 *    `wrap`/`hard` both split — so `StreamLine` sizes a `<Box>` to each line, and this is the test that
 *    proves it on a terminal rather than in a 100-column fake.
 * 3. **Nothing leaves the normal screen buffer.** No alternate screen, no clear-screen: the session's
 *    output is still there afterwards, which is the whole reason this shape was chosen over a full-screen
 *    app.
 * 4. **The last frame is left behind**, so a session that has stopped still says how it ended.
 * 5. **A resize burst paints on its trailing edge only** (#736, #760). The harness drags its own
 *    terminal narrower and wider with `stty`, which arrives as SIGWINCH exactly as a window manager's
 *    does. Inside a burst Ink's own resize paint is muted (subscription-time, `app.tsx`/`resize.ts`)
 *    and each event erases from the anchor down — the mute covers that paint alone: the 80 ms tick and
 *    any line committed mid-drag still render frames through a burst (the bound below measures them).
 *    The settle paints once, at the final size — and a settle that ends a multi-event drag rebuilds
 *    the viewport, restating the visible tail of the stream in rows measured at the new width. A byte
 *    stream does not rewrap, so this cannot see the stale headers a rewrapping terminal stacked up —
 *    `devTui.windows.test.ts` reads those off a real ConPTY. What this holds is the half a byte
 *    stream can: how often the repaint fires, and what a reader can scroll to — every committed line
 *    present, in order, and in the settled screen each appearing exactly once.
 *
 * A pty is required and a fake will not do, for the reason `capabilities/secretPrompt.pty.test.ts` gives
 * about `password()`: this behavior is the *terminal's* and Ink's, not ours. `script(1)` allocates it,
 * exactly as that file and `commands/secretsInteractive.test.ts` do — and, as there, the harness is
 * written to a temp file rather than shipped in `src/`, because every non-test `src/*.ts` is a published
 * entry of `@pithy-sh/cli`.
 */

/** Where `bun` is, or `null` — the harness imports `.ts`/`.tsx` deep paths, which only Bun runs. */
function bunPath(): string | null {
  try {
    return execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Whether `script(1)` is here to allocate a pty. util-linux, so: Linux CI and Linux dev boxes. */
function hasScript(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v script"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BUN = bunPath();
const RUNNABLE = BUN !== null && hasScript();

/** 300 ordinary lines, well past the 24-row terminal, plus one far wider than its 80 columns. */
const LINES = 300;
const LONG = `[api] Error: ${"segment/".repeat(45)}end`;

/** The terminal's height, which the resize phase never changes: a drag here is a change of width. */
const ROWS = 24;

/** The widths the resize phase settles at — narrower than the start, then wider. */
const SETTLED = [60, 120];

/**
 * The resize phase: a drag to each settled width, a step of a few columns at a time as a window manager
 * sends them, then a pause long enough for the footer to settle and a marker written at that size.
 */
const RESIZE_PHASE = `
const { execFileSync } = await import("node:child_process");
const rest = (ms) => new Promise((r) => setTimeout(r, ms));
const width = (cols) => execFileSync("stty", ["cols", String(cols)], { stdio: "inherit" });
let cols = 80;
for (const target of ${JSON.stringify(SETTLED)}) {
  const step = target > cols ? 5 : -5;
  for (cols += step; step > 0 ? cols < target : cols > target; cols += step) {
    width(cols);
    await rest(20);
  }
  cols = target;
  width(cols);
  await rest(600);
  store.line("MARK-" + process.stdout.columns, "api");
  await rest(400);
}
`;

const HARNESS = devTuiHarness({
  keys: false,
  script: `
store.line(${JSON.stringify(LONG)}, "api");
for (let i = 0; i < ${LINES}; i++) store.line("L" + i, "api");
/**
 * Wait for Ink to have committed every line, rather than for a fixed interval.
 *
 * A fixed sleep here is the shape that passes on an idle machine and fails in a full suite: Ink commits
 * the static region on its own render schedule, and under CPU contention 300 lines take longer than any
 * number this test could pick. The frames themselves cannot be observed from inside the process, so the
 * proxy is the store - every line has to have left the buffer and been committed - followed by a short
 * settle for the final render.
 */
const committed = () => store.state().lines.length;
const deadline = Date.now() + 20_000;
let seen = -1;
while (Date.now() < deadline) {
  if (committed() >= ${LINES} + 1 && committed() === seen) break;
  seen = committed();
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 400));
${RESIZE_PHASE}
store.event({ event: "exited", worker: "support", code: 1 });
await new Promise((r) => setTimeout(r, 300));
await tui.stop();
`,
});

let workspace: string;
let transcript: string;

beforeAll(() => {
  if (!RUNNABLE) return;
  workspace = mkdtempSync(join(tmpdir(), "pithy-devtui-pty-"));
  const harness = join(workspace, "harness.ts");
  const out = join(workspace, "out.txt");
  writeFileSync(harness, HARNESS);
  // **`stty` first.** A pty whose stdout is a pipe starts 0x0, and a zero-column terminal wraps every
  // line after one character — which would make claim 2 below unfalsifiable rather than true.
  const command = `stty rows ${ROWS} cols 80; ${BUN as string} ${harness}`;
  execFileSync("script", ["-qec", command, out], { stdio: "ignore", timeout: 120_000, env: harnessEnv() });
  transcript = readFileSync(out, "utf8").replace(/\r\n/g, "\n");
}, 140_000);

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/**
 * The transcript with color *and cursor control* removed — the text a reader would see.
 *
 * Broader than `dev/logging.ts`'s `stripAnsi`, which matches only the SGR `…m` sequences it needs for a
 * log file. What is being asserted here includes the absence of cursor movement, so the sequences have to
 * be removed to read the text and counted separately to make the claim.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI ESC (\x1b) is the point — this strips a real terminal's escape sequences.
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const plain = () => transcript.replace(ANSI, "");

describe.runIf(RUNNABLE)("the live footer on a real terminal", () => {
  test("every committed line survives, in order, and none is destroyed", () => {
    // First appearances: a line missing or reordered is the destruction #736 shipped (main's stale
    // erases ate lines outright), and this is the claim over the *whole* stream. Exact occurrence
    // counts cannot ride a byte transcript — the settle rebuild restates the visible tail, so tail
    // lines are legitimately in the bytes 1 + (restatements) times. "Exactly once" is a property of
    // a screen, and the screen half is asserted in the settled-screen test below, where each visible
    // line has precisely one copy.
    const seen = [...plain().matchAll(/\bL(\d+)\b/g)].map((m) => Number(m[1]));
    const firstSeen = seen.filter((n, index) => seen.indexOf(n) === index);
    expect(firstSeen).toEqual(Array.from({ length: LINES }, (_, index) => index));
  });

  test("a line far wider than the terminal arrives in one piece", () => {
    // 368 characters in an 80-column terminal. Present verbatim means no newline was inserted into it.
    expect(plain()).toContain(LONG);
  });

  test("nothing leaves the normal screen buffer", () => {
    expect(transcript).not.toContain("\x1b[?1049h");
    expect(transcript).not.toContain("\x1b[2J");
  });

  test("the last frame is left behind, naming how the session ended", () => {
    // The footer is not erased on the way out: the roster as it stood is ordinary output afterwards.
    const tail = plain().slice(-600);
    expect(tail).toContain("api");
    expect(tail).toContain("support");
    expect(tail).toContain("exited (1)");
  });

  test("the roster reports time-to-ready rather than a running clock", () => {
    // `api` became ready at the same instant it spawned and stays at its own elapsed; a session clock
    // would have climbed past a second while the 300 lines were committed.
    expect(plain()).toMatch(/api\s+app\s+8787\s+ready\s+0\.0s/);
  });

  test("a drag paints its footer on the trailing edge, not once per event", () => {
    // The guard (`#736`'s unwrapped-frame write) opens every frame Ink writes, so frames are countable
    // in the bytes. The window from one marker to the next carries a full drag — 12 width changes at
    // ~20 ms steps — and the session's spinner: with a worker still building, the 80 ms tick owns the
    // window's floor, and the shipped mechanism measured 17 guarded frames inside it. The bound sits
    // above that and below the disease: main's bytes carry no guard at all (measured 0), which the
    // global floor below catches — it fails a per-event repaint the same way, since the mechanism
    // before #760 painted on each event's leading edge and the guard count is how frames are seen.
    const from = transcript.indexOf(`MARK-${SETTLED[0]}`);
    const to = transcript.indexOf(`MARK-${SETTLED[1]}`);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(transcript.slice(from, to).split(NO_WRAP).length - 1).toBeLessThanOrEqual(22);
    expect(transcript.split(NO_WRAP).length - 1).toBeGreaterThan(SETTLED.length);
  });

  test("a marker written at each settled size arrives, in order, and the settled screen holds one of each", () => {
    // Arrival: first appearances, in the order the sizes came — a destroyed marker is what #736's
    // stale erases did. Multiplicity: asserted on the screen below, not the bytes — the settle
    // rebuild restates the visible tail, and a restated marker is a replacement, not a fan.
    const markers = [...plain().matchAll(/MARK-(\d+)/g)].map((m) => Number(m[1]));
    expect(markers.filter((m, index) => markers.indexOf(m) === index)).toEqual(SETTLED);
  });

  test("the settled screen a reader ends on holds each visible stream line exactly once", () => {
    // The screen the last rebuild leaves: find the last rebuild's `ESC[1J` + `ESC[H` in the bytes,
    // and read from there on as what is on screen. The restatement wrote the visible tail there (one
    // copy each), the markers committed on top of it, and nothing below the anchor restates twice.
    // This is the ANSI-aware frame-model reading of "exactly once in what a reader can scroll to"
    // for a transcript harness: the tail region of the settled screen. On main there is no `ESC[1J`
    // at all (the scroll-away mechanism clears by newlines), so the cut goes red at the anchor —
    // red on the disease, green on the cure.
    const cut = transcript.lastIndexOf("\x1b[1J\x1b[H");
    expect(cut, "no rebuild restatement in the transcript").toBeGreaterThan(-1);
    const screen = transcript.slice(cut).replace(ANSI, "");
    for (const n of [298, 299]) {
      expect([...screen.matchAll(new RegExp(`\\bL${n}\\b`, "g"))]).toHaveLength(1);
    }
    expect([...screen.matchAll(/MARK-60/g)]).toHaveLength(1);
    expect([...screen.matchAll(/MARK-120/g)]).toHaveLength(1);
    // And the deep stream is *not* restated: the rebuild writes the visible tail, measured, not the
    // uncapped store (finding 1's `slice(NaN)` shipped the whole session).
    expect(screen).not.toMatch(/\bL7\b/);
  });

  test("after the last repaint the screen holds one roster header", () => {
    // Cut at the last guarded frame that carries the roster. The last guard in the transcript can be
    // teardown's: quitting erases the footer and writes an empty frame after it, and a cutter that
    // takes the *final* guard then slices the exit, not the screen the drag left. One frame per
    // split segment, honest by construction: each is what was written between two guards.
    // On main's bytes there is no guard at all — the single "frame" is the whole transcript, the
    // staircase is inside it, and the count below goes red. Red on the disease, green on the cure.
    const frames = transcript.split(NO_WRAP).map((frame) => frame.replace(ANSI, ""));
    const header = /^\s+worker\s+kind/m;
    let carried: string | undefined;
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      if (frame && header.test(frame)) {
        carried = frame;
        break;
      }
    }
    expect(carried, "no guarded frame after the resize").toMatch(header);
    expect([...(carried ?? "").matchAll(/^\s+worker\s+kind/gm)]).toHaveLength(1);
  });
});
