// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IPty, spawn } from "@lydell/node-pty";
import headless from "@xterm/headless";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { devTuiHarness, harnessEnv } from "../../test-utils/devTuiHarness";
import { requireWindows } from "../../test-utils/windows";

requireWindows();

/**
 * **#736 on a real ConPTY: resizing the window while `pithy dev` runs.**
 *
 * Ink repaints the footer by erasing the rows it drew last time, counted from the cursor. ConPTY rewraps
 * its buffer on a resize, so the count goes stale and the erase lands on the wrong rows: on a drag, every
 * spinner-tick repaint left the previous roster's rule and header behind, stacking up the screen. The
 * fix mutes Ink's resize paint for the length of a burst, erases from the footer's anchor on every
 * event, and repaints once at the final geometry when the size settles (`resize.ts`, wired from
 * `app.tsx`).
 *
 * The Linux pty test cannot see this. It reads the bytes the program wrote, and a byte stream does not
 * rewrap — only a terminal does. So this one runs where the rewrap happens: a real pseudoconsole, resized
 * from the host side exactly as Windows Terminal resizes one, around the real store and the real
 * `startTui`.
 *
 * **What it reads is the screen, not the transcript.** ConPTY is not a pipe: it renders its own buffer and
 * re-emits it, so after a resize the same line arrives many times in the bytes (twenty copies of one marker
 * were measured). Stripping escapes from that stream says nothing about what anyone sees. The bytes go
 * through `@xterm/headless`, a terminal emulator resized in step with the pseudoconsole, and the assertions
 * read its viewport.
 *
 * **ConPTY is the one node-pty bundles** (`useConptyDll`), the OpenConsole that ships with Windows
 * Terminal, rather than whichever one the runner's Windows build carries. Same terminal stack on every
 * machine, and the one the bug was reported on.
 *
 * The harness drives the session from the keyboard, as `pithy dev` is driven: `1` asks it to commit a
 * marker naming the width it sees, `q` quits. A footer that lost its keys across the repaint would drop
 * the marker, so that is checked too.
 */

/** Where `bun` is — the harness imports `.ts`/`.tsx` deep paths, which only Bun runs. ConPTY wants a path. */
function bunPath(): string {
  const found = execFileSync("where.exe", ["bun"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim();
  if (!found) throw new Error("bun is not on PATH.");
  return found;
}

const COLUMNS = 80;
const ROWS = 24;

/** Wide to narrow to wide, three times: both directions of the rewrap, at sizes the footer lays out differently. */
const SIZES = [50, 120, 60, 100, 70, 110];

/** A drag, not a jump: the window manager sends a resize per few pixels, a few dozen per drag. */
const DRAG_STEP = 4;
const DRAG_INTERVAL_MS = 25;

/** A pause after each drag, well past the repaint's 150 ms debounce, before the marker is asked for. */
const SETTLE_MS = 1_000;

/**
 * How long a marker and the footer drawn under it may take to reach the screen. A ceiling, not a sleep:
 * the wait ends the moment the screen shows both, and a runner under load gets the time it needs. Past
 * it, the assertions read whatever is there.
 */
const SCREEN_CEILING_MS = 10_000;

const HARNESS = devTuiHarness({
  keys: true,
  onDigit: `() => store.line("MARK-" + process.stdout.columns, "api")`,
  onQuit: "() => void tui.stop().then(() => process.exit(0))",
  script: `
for (let i = 0; i < 40; i++) store.line("L" + i, "api");
store.line("HARNESS-READY", "api");
`,
});

const rest = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let workspace: string;
let pty: IPty | undefined;
let viewport: string[];
let fullBuffer: string[];
let blankGap: number;
let markers: string[];
let exitCode: number | undefined;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "pithy-devtui-conpty-"));
  const harness = join(workspace, "harness.ts");
  writeFileSync(harness, HARNESS);

  const terminal = new headless.Terminal({ cols: COLUMNS, rows: ROWS, scrollback: 5_000, allowProposedApi: true });
  let bytes = "";
  const session = spawn(bunPath(), [harness], {
    cols: COLUMNS,
    rows: ROWS,
    cwd: workspace,
    env: { ...harnessEnv(), NO_COLOR: "1" },
    useConptyDll: true,
  });
  pty = session;
  session.onData((data) => {
    bytes += data;
    terminal.write(data);
  });
  // The terminal answers what it is asked. OpenConsole opens with a device-attributes query and holds
  // the keyboard until a reply arrives, as it would from Windows Terminal.
  terminal.onData((reply) => session.write(reply));
  const exited = new Promise<number>((resolve) => session.onExit(({ exitCode }) => resolve(exitCode)));

  const deadline = Date.now() + 60_000;
  while (!bytes.includes("HARNESS-READY")) {
    if (Date.now() > deadline) throw new Error(`The harness never became ready. It wrote: ${JSON.stringify(bytes)}`);
    await rest(50);
  }
  await rest(SETTLE_MS);

  // What the screen shows: the last ROWS lines of the buffer, after everything sent has been parsed.
  const screen = async (): Promise<string[]> => {
    await new Promise<void>((resolve) => terminal.write("", resolve));
    const buffer = terminal.buffer.active;
    return Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
    ).slice(-ROWS);
  };
  // Settled, for one size: its marker is on screen with a whole footer under it — a header, the `api` row
  // and the rule that closes it, in that order. Not "exactly one footer": that is the claim under test,
  // and a wait that required it would turn a stacked screen into a timeout instead of a failure that
  // shows it.
  const settled = (lines: string[], marker: string) => {
    const at = lines.map((line) => line.includes(marker)).lastIndexOf(true);
    if (at === -1) return false;
    const header = lines.findIndex((line, index) => index > at && HEADER.test(line));
    const api = lines.findIndex((line, index) => index > header && /api\s+app\s+8787\s+ready/.test(line));
    return header !== -1 && api !== -1 && lines.some((line, index) => index > api && RULE.test(line));
  };

  const resize = (columns: number) => {
    session.resize(columns, ROWS);
    terminal.resize(columns, ROWS);
  };
  let columns = COLUMNS;
  for (const target of SIZES) {
    const step = target > columns ? DRAG_STEP : -DRAG_STEP;
    for (let at = columns + step; step > 0 ? at < target : at > target; at += step) {
      resize(at);
      await rest(DRAG_INTERVAL_MS);
    }
    resize(target);
    columns = target;
    await rest(SETTLE_MS);
    session.write("1");
    const until = Date.now() + SCREEN_CEILING_MS;
    while (!settled(await screen(), `MARK-${target}`) && Date.now() < until) await rest(100);
  }

  // Everything the terminal holds, scrollback and screen, flushed through the emulator's parser first.
  await new Promise<void>((resolve) => terminal.write("", resolve));
  const buffer = terminal.buffer.active;
  const lines = Array.from(
    { length: buffer.length },
    (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
  );
  viewport = lines.slice(-ROWS);
  fullBuffer = lines;
  markers = lines.flatMap((line) => line.match(/MARK-\d+/g) ?? []);

  // The blank rows a settled screen leaves under its newest marker: between the committed lines and the
  // roster header, and below the footer. Scroll-away made room for each repaint by pushing the viewport
  // with blank rows, so the live frame ends up sitting on a shelf of them; the in-place repaint erases
  // and redraws on the same rows, leaving the footer on the bottom of the screen, under its lines.
  const markerAt = viewport.map((line) => /MARK-\d+/.test(line)).lastIndexOf(true);
  blankGap = viewport.slice(markerAt + 1).filter((line) => line.trim() === "").length;

  session.write("q");
  exitCode = await Promise.race([exited, rest(15_000).then(() => undefined)]);
}, 180_000);

afterAll(() => {
  try {
    pty?.kill();
  } catch {
    // Already gone, which is the expected case: `q` ended it.
  }
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/** A roster header, as the footer draws it: dim, then two spaces, then the column names. */
const HEADER = /^\s*worker\s+kind\s/;
/** The footer's rule: a run of box-drawing dashes, possibly cut short with an ellipsis at a narrower width. */
const RULE = /^─{8,}/;

/**
 * Full-buffer ceilings for the #736 test below, measured on this harness with the shipped repaint: one
 * header and two rules across all 217 lines the terminal holds after the six cycles. They are exact
 * counts, not slack: a repaint that erases its frame in place cannot produce more, and the mechanism they
 * guard against produces one pair per resize, not per cycle.
 */
const HEADER_CEILING = 1;
const RULE_CEILING = 2;

describe("the live footer on ConPTY, resized while it runs", () => {
  test("the settled screen holds exactly one roster header", () => {
    expect(
      viewport.filter((line) => HEADER.test(line)),
      viewport.join("\n"),
    ).toHaveLength(1);
  });

  test("and exactly one footer: its two rules, no stale ones stacked above", () => {
    // The staircase is rules as much as headers: a stale frame leaves its top rule behind even where its
    // header was erased, so a header count alone can read 1 over a screen of debris.
    expect(
      viewport.filter((line) => RULE.test(line)),
      viewport.join("\n"),
    ).toHaveLength(2);
  });

  test("the footer on the settled screen is the current one", () => {
    const header = viewport.findIndex((line) => HEADER.test(line));
    expect(viewport[header + 1]).toMatch(/api\s+app\s+8787\s+ready/);
    expect(viewport[header + 2]).toMatch(/support\s+\S+\s+8790/);
  });

  test("the whole buffer, scrollback included, is not a staircase of retired footers (#736)", () => {
    // The viewport checks above pin what a user sees; they do not pin how it got there. The mechanism this
    // PR replaced (#744) scrolled each superseded frame into the scrollback instead of erasing it in place,
    // so its viewport also showed one header and passed every check above, while its scrollback filled with
    // 99 headers and 108 rules on the recorded drag (the trace and its replay are on the record in
    // https://github.com/pithy-sh/pithy/pull/760#issuecomment-6195090993). The shipped repaint scores
    // 1 header and 2 rules across the whole buffer, here and in that replay. The
    // ceilings are those measured counts, not hoped-for ones; a mechanism that retires a frame per resize
    // grows the buffer with the number of cycles, so they bind here in a way a viewport-only count cannot.
    expect(
      fullBuffer.filter((line) => HEADER.test(line)),
      fullBuffer.join("\n"),
    ).toHaveLength(HEADER_CEILING);
    expect(
      fullBuffer.filter((line) => RULE.test(line)),
      fullBuffer.join("\n"),
    ).toHaveLength(RULE_CEILING);
  });

  test("the settled screen shows no blank gap from the newest marker down to the footer's rows", () => {
    // Scroll-away cleared the viewport with blank rows to make room for the next repaint, so its settled
    // footer sat on a shelf of them, away from the lines the session had committed. The in-place repaint
    // erases the frame it drew and draws the new one on the same rows, so from the last marker down to the
    // bottom of the screen there is the footer, not blank rows.
    expect(blankGap).toBeLessThanOrEqual(2);
  });

  test("a marker committed at every settled size is on the buffer exactly once, in the order the sizes came", () => {
    // Exact counts on the emulator's whole buffer (scrollback plus viewport) — what a reader scrolls.
    // ConPTY re-emits reflowed lines into the *bytes*, which is why this suite reads the screen and not
    // the transcript. The rebuild restates the visible tail: the erase removes each line and the
    // restatement writes it back, so a marker's first appearances on the buffer read in the order the
    // sizes came, each exactly once. Copies beyond the first — repaints racing the erase can re-deliver
    // a boundary line — are the fan bound's business, below.
    expect(markers).toEqual(SIZES.map((columns) => `MARK-${columns}`));
  });

  test("every committed stream line is on the whole buffer, in order, with no fan of copies", () => {
    // First appearances, top-down over scrollback plus viewport, must read L0..L39 in order: a
    // destroyed line (main's stale erases) drops it, a reordered stream reorders the list. The count
    // ceiling is the fan guard: the `slice(NaN)` bug restated the *whole* store at every rebuild,
    // which puts a copy of every line per drag cycle into the buffer — six cycles, seven copies. The
    // measured restatement reaches only the visible tail, and ConPTY's reflow re-emits can add one
    // copy at the boundary, so the bound is three. Lines the tail never touched stay at one.
    const counts = new Map<string, number>();
    const firstAppearance: string[] = [];
    for (const line of fullBuffer) {
      for (const match of line.matchAll(/\bL\d+\b/g)) {
        counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
        if (!firstAppearance.includes(match[0])) firstAppearance.push(match[0]);
      }
    }
    expect(firstAppearance).toEqual(Array.from({ length: 40 }, (_, index) => `L${index}`));
    for (const [line, count] of counts) {
      expect(count, `${line} appears ${count} times`).toBeLessThanOrEqual(3);
    }
  });

  test("the keys still work after the repaints, and q ends the session", () => {
    expect(exitCode).toBe(0);
  });
});
