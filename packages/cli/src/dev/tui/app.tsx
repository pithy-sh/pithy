// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Box, render, Static, Text, useInput, useStdout } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import { dim } from "../../terminal/style";
import { stripAnsi } from "../logging";
import { ticking } from "./choose";
import { Footer, SPINNER_INTERVAL_MS } from "./footer";
import { IdentityPicker } from "./identityPicker";
import type { BarKey } from "./roster";
import type { WorkerRow } from "./session";
import type { CommittedLine, DevStore } from "./store";

/**
 * The keys the bar advertises, in order, and what each one needs from the selected row.
 *
 * **A capability host is neither a web page nor a sign-in.** `email`, `payments`, `support` and `secrets`
 * each run a host Worker with no front end and no auth routes, and in a real project they are most of the
 * roster — so `o` and `l` are dimmed on them rather than silently doing nothing. `r`, `f` and `a` apply to
 * any worker, and `q` to the session.
 */
const KEY_BAR = [
  { key: "r", label: "restart", needs: "worker" },
  { key: "o", label: "open", needs: "ready-app" },
  // `f` is this worker's output and `F` is everyone's: one pair, one idea, and the shift is the "all".
  // They share a slot on the bar — see `barKeys` — but each is gated on its own terms.
  { key: "f", label: "logs", needs: "started" },
  { key: "F", label: "all logs", needs: "always" },
  // `a` for the thing the column is called, rather than `p` for a word only the docs use.
  { key: "a", label: "autostart", needs: "worker" },
  { key: "l", label: "login", needs: "ready-app" },
  { key: "q", label: "quit", needs: "always" },
] as const;

/**
 * The bar, which is **not** one segment per key.
 *
 * `f` and `F` are one idea — this worker's output, or everyone's — and spending two slots on them read
 * as two unrelated keys. They share one.
 *
 * **The segment depends on the row, because the two keys do not apply on the same terms.** `F` always
 * works; `f` needs a worker that started. So a parked row advertises `F all logs` alone rather than a
 * merged segment dimmed on `f`'s behalf — which would have said that neither worked, when one does, and
 * a key the bar draws dim is a key that does nothing.
 *
 * Every other key keeps its own slot, with the label naming what it will do to *this* row.
 */
function barKeys(row: MarkedRow | undefined, enabled: ReadonlyMap<string, boolean>): BarKey[] {
  const canFocus = enabled.get("f") === true;
  return KEY_BAR.flatMap<BarKey>((k) => {
    if (k.key === "F") return [];
    if (k.key === "f") {
      return canFocus
        ? [{ key: "f", label: "logs (F all)", enabled: true }]
        : [{ key: "F", label: "all logs", enabled: true }];
    }
    return [
      {
        key: k.key,
        // The label says what the key will do to *this* row: `r` is a start on a parked row, and `a`
        // reads as the state it is moving to.
        label:
          k.key === "r" && row?.status === "skipped"
            ? "start"
            : k.key === "a"
              ? `autostart ${row?.autostart === false ? "on" : "off"}`
              : k.label,
        enabled: enabled.get(k.key) ?? true,
      },
    ];
  });
}

/** The row the marker is on, as the key bar needs to read it. */
type MarkedRow = { kind: "app" | "host"; status: WorkerRow["status"]; autostart?: boolean };

/**
 * Whether a key does anything on the row the marker is on.
 *
 * Three facts decide it. **A capability host** is neither a web page nor a sign-in, and in a real project
 * is most of the roster. **A parked worker** is not running, so there is nothing to open, sign into, or
 * read output from — but it is the row you would press `r` on, which is why `r` applies to every row.
 * **A worker that has exited** has output worth reading and nothing to open.
 */
function applies(needs: "always" | "worker" | "ready-app" | "started", row: MarkedRow | undefined): boolean {
  if (needs === "always") return true;
  if (!row) return false;
  if (needs === "worker") return true;
  const started = row.status !== "skipped";
  if (needs === "started") return started;
  /**
   * **`l` is not gated on an identity, and gating it was a regression.**
   *
   * The `login` event is raised once, before anything spawns, so its count is a snapshot. Gating the key
   * on it — with a dimmed key being genuinely inert — made `l` dead for the life of any session that
   * started unseeded: `pithy seed` in a second terminal, press `l`, nothing. That is the bug this change
   * set set out to fix, reintroduced two rounds later from the other end.
   *
   * So the key always fires on a ready app worker, and the supervisor answers: it re-reads the record on
   * every press, opens the only identity, offers the picker, or says `No dev login is seeded. Run pithy
   * seed, then press l again.` — advice that is now true.
   */
  // **`ready` and not merely started.** Opening a worker that has not matched its ready signal gives a
  // connection error, and signing into one gives a dead route — `wrangler dev` has not bound the port
  // yet, and with a front end that can be a long time (#674). So `o` and `l` wait for the row to say
  // `ready`, not for its child to exist.
  return started && row.status === "ready" && row.kind === "app";
}

/** §9: width from the terminal, falling back to 80 when it will not say. */
const FALLBACK_COLUMNS = 80;

/**
 * One committed line, sized so Ink does not rewrap it.
 *
 * **This `<Box>` is the whole reason the stream stays byte-identical to a plain run.** Ink measures a
 * `<Text>` against its container and splits anything wider onto a second line, which puts a real newline
 * into the middle of a long stack trace: it no longer copies as one line, and it never rejoins when the
 * window widens, because a soft wrap is the terminal's and a hard wrap is ours. `wrap` cannot fix it in
 * either direction — `truncate` keeps only the first terminal-width characters and `wrap`/`hard` both
 * split — so the container is made wide enough that there is nothing to wrap, and the terminal soft-wraps
 * exactly as it does today.
 *
 * Sized from the line's own ANSI-stripped length rather than from a fixed ceiling: a magic 4096 would be
 * a silent cliff for the one line longer than it, and escape sequences occupy no columns.
 */
function StreamLine({ line }: { line: CommittedLine }): React.ReactElement {
  return (
    <Box width={stripAnsi(line.text).length + 1} flexShrink={0}>
      <Text>{line.text}</Text>
    </Box>
  );
}

/**
 * `pithy dev`'s live surface: the session's own output, committed once and never redrawn, with the roster
 * pinned underneath it.
 *
 * Everything above the footer is `<Static>`, which writes each line to real stdout and never touches it
 * again — so the terminal's scroll, selection and copy work exactly as they do on the plain path, and the
 * session logs are unaffected in both. Only the footer repaints.
 */
export function DevTui(props: {
  store: DevStore;
  /** Whether there is a keyboard to read. False on `pithy dev < /dev/null`. */
  keys: boolean;
  onRestart: (worker: string) => void;
  onOpen: (worker: string) => void;
  /**
   * Sign in on a worker.
   *
   * Takes the row, because **an app stack can carry more than one front end** and wanting to sign in on
   * either is reasonable. The marker is the answer: it removes the heuristic the plain path still needs,
   * where the worker carrying a UI wins and a tie prints the choices.
   */
  onLogin: (worker: string) => void;
  /** Sign in as the identity the picker settled on. */
  onSignIn: (userId: string, worker?: string) => void;
  /**
   * Turn this branch's autostart for a worker on or off — what the **next** `pithy dev` will do, not
   * this one.
   */
  onAutostart: (worker: string, autostart: boolean) => void;
  /**
   * A digit, forwarded verbatim to the supervisor.
   *
   * **Digits belong to `l`'s identity list, not to the roster.** `pithy seed` can mint several signed-in
   * identities and `l` numbers them, so a digit is already an answer to a question the session asked
   * (#667). Binding it here as "jump to row N" would have made the same keystroke mean two things, and
   * which one it meant would have depended on whether anyone had pressed `l` recently. The roster moves
   * on the arrow keys alone; the supervisor's own handler is inert when no list is open.
   */
  onDigit: (digit: string) => void;
  onQuit: () => void;
  onInterrupt: () => void;
}): React.ReactElement {
  const state = useSyncExternalStore(props.store.subscribe, props.store.state);
  const selectedRow = state.session.workers[state.selected];
  /**
   * Which keys do anything on the marked row — **read by the handler as well as by the bar.**
   *
   * Computing it twice is how a dimmed key stays live: `o` was drawn dim on a capability worker and
   * still opened it. One value, both readers.
   */
  const enabled = new Map<string, boolean>(KEY_BAR.map((k) => [k.key, applies(k.needs, selectedRow)]));
  const { stdout } = useStdout();
  const [now, setNow] = useState(() => new Date());

  // **The tick runs only while something is still coming up.** A command left open all day should not be
  // redrawing a clock into somebody's battery, so once every worker has arrived the footer is static
  // until the next event moves it.
  const moving = ticking(state.session.workers);
  useEffect(() => {
    if (!moving) return;
    const id = setInterval(() => setNow(new Date()), SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [moving]);

  useInput(
    (input, key) => {
      // Ctrl-C outranks everything, including an open question.
      if (key.ctrl && input === "c") return void props.onInterrupt();

      /**
       * **While the picker is open it owns every key but Ctrl-C.**
       *
       * `r`, `o`, `f`, `a` and `q` are inert here on purpose: the roster is not on screen, so there is no
       * row they could be read against, and `q` in particular would tear the session down in answer to a
       * question about signing in. `esc` is the way out, and it is on the bar.
       */
      if (state.picker) {
        // `esc` clears a query before it closes anything — narrowing 29 to 2 and then wanting the 29
        // back is one keystroke, not a reopen.
        if (key.escape) {
          if (state.picker.query !== "") return void props.store.clearPickerQuery();
          return void props.store.closePicker();
        }
        if (key.downArrow) return void props.store.movePicker(1);
        if (key.upArrow) return void props.store.movePicker(-1);
        if (key.backspace || key.delete) return void props.store.backspacePicker();
        if (key.return) {
          const choice = props.store.pickerChoice();
          // Closed first, so the roster is back before the browser opens over it.
          props.store.closePicker();
          if (choice) props.onSignIn(choice.identity.userId, choice.worker);
          return;
        }
        /**
         * **Anything else printable is filter text**, digits included: an email contains them
         * (`user12@…`), so a digit cannot also mean "jump to row 1".
         *
         * A whole chunk rather than one character, because that is what arrives — Ink delivers a fast
         * sequence or a paste as a single `input`, and a length-1 guard silently dropped every one of
         * them. Control bytes are stripped rather than the chunk rejected, so a stray escape in the
         * middle of a paste costs the escape and not the paste.
         */
        if (!key.ctrl && !key.meta) {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes from raw terminal input is the point.
          const typed = input.replace(/[\u0000-\u001f\u007f]/g, "");
          if (typed !== "") return void props.store.typePicker(typed);
        }
        return;
      }
      if (key.downArrow) return void props.store.move(1);
      if (key.upArrow) return void props.store.move(-1);

      // One character. Ink delivers a fast sequence or a paste as a single `input`, and a bare
      // lexicographic range is true for `"12"` as well as `"1"` — which forwarded the whole chunk to
      // `pickIdentity`, where it matched nothing and consumed the pending list, so the identity `l` had
      // just offered silently went away.
      if (input.length === 1 && input >= "1" && input <= "9") return void props.onDigit(input);

      const worker = props.store.selectedWorker();
      // A key the row cannot do is inert, not merely dim.
      if (enabled.get(input) === false) return;
      switch (input) {
        case "r":
          if (worker) props.onRestart(worker);
          return;
        case "o":
          if (worker) props.onOpen(worker);
          return;
        case "f":
          // A toggle on the selected row. Worker output is hidden by default — the roster is what the
          // footer is for, and five workers' startup chatter is what buried it — so this is how you ask
          // for one worker's, and asking again is how you stop.
          if (worker) {
            if (state.revealed.includes(worker)) props.store.hide(worker);
            else props.store.reveal(worker);
          }
          return;
        case "F":
          // Everything, or back to quiet. The escape hatch for "just show me the lot", which is what the
          // plain stream has always been.
          props.store.showAll(!state.showingAll);
          return;
        case "a":
          // What `dev-ports.json` calls autostart, toggled on the row. Never this run — the next one.
          if (worker) props.onAutostart(worker, selectedRow?.autostart === false);
          return;
        case "l":
          if (worker) props.onLogin(worker);
          return;

        case "q":
          props.onQuit();
          return;
        case "?": {
          /**
           * **The one key a collapsed bar offers, and it did nothing.**
           *
           * `keyBarSegments` falls back to `? keys` on a terminal too narrow for the verbs, and the
           * docs name `?` as the key list — but there was no case for it. Committed to the stream
           * rather than drawn as a pane: it works at any width, it survives being scrolled back to,
           * and it needs no mode to leave.
           */
          props.store.line(dim("  keys"));
          for (const key of KEY_BAR) props.store.line(dim(`    ${key.key}  ${key.label}`));
          props.store.line(dim("    ↑↓  move the marker"));
          return;
        }
        default:
          return;
      }
    },
    { isActive: props.keys },
  );

  return (
    <>
      {/* The store replaces this array whenever it grows, which is exactly what `<Static>` needs: it
          memoizes on the array's identity and would otherwise skip every new line. Cast rather than
          copied — Ink types `items` as mutable and never writes to it, and copying here would be a
          second O(n) pass on every repaint of the footer. */}
      <Static items={state.lines as CommittedLine[]}>{(line) => <StreamLine key={line.id} line={line} />}</Static>
      {state.picker ? (
        <IdentityPicker
          identities={state.picker.identities}
          selected={state.picker.selected}
          query={state.picker.query}
          columns={stdout?.columns ?? FALLBACK_COLUMNS}
        />
      ) : (
        <Footer
          state={state.session}
          now={now}
          columns={stdout?.columns ?? FALLBACK_COLUMNS}
          keys={props.keys ? barKeys(selectedRow, enabled) : []}
          selected={state.selected}
          revealed={state.revealed}
        />
      )}
    </>
  );
}

/** What `commands/dev.ts` holds onto: the store to push into, and the way to put the terminal back. */
export interface TuiHandle {
  store: DevStore;
  /** Unmount, leaving the last frame printed as ordinary output, and restore the terminal. */
  stop: () => Promise<void>;
}

/**
 * Mount the footer over this session's output.
 *
 * **Deliberately thin, and deliberately not unit-tested.** Every decision with behavior behind it is
 * either tested above (`DevTui`) or is a property only a real terminal can settle, which
 * `devTui.pty.test.ts` settles: that committed lines survive in scrollback, that the final frame is left
 * behind rather than erased, and that a long line is not split.
 *
 * Ink is imported statically here and this whole module is reached through `await import` instead, which
 * is the same guarantee one level up and one fewer moving part: `ci/lazyHeavyImports.test.ts` walks the
 * graph from each command, and `commands/dev.ts` reaches this file only from inside the branch that has
 * already decided a footer is wanted.
 *
 * Two options carry weight:
 *
 * - **`exitOnCtrlC: false`.** Ink's default unmounts and exits the process on Ctrl-C, which would orphan
 *   every `wrangler → workerd` subtree — the exact condition `pithy dev`'s `lsof` sweep exists to clean
 *   up after. Ctrl-C belongs to `shutdown`, which SIGTERMs each process group, waits out the grace
 *   window, SIGKILLs survivors and removes `.dev-state.json`.
 * - **`patchConsole: false`.** Ink's default intercepts `console.*` and reprints it above the frame. The
 *   supervisor writes through its own `stdout` seam, which this renderer already owns, and a second
 *   interception would reorder the stream against the roster.
 */
export function startTui(options: {
  store: DevStore;
  keys: boolean;
  onRestart: (worker: string) => void;
  onOpen: (worker: string) => void;
  onLogin: (worker: string) => void;
  onSignIn: (userId: string, worker?: string) => void;
  /**
   * Turn this branch's autostart for a worker on or off — what the **next** `pithy dev` will do, not
   * this one.
   */
  onAutostart: (worker: string, autostart: boolean) => void;
  onDigit: (digit: string) => void;
  onQuit: () => void;
  onInterrupt: () => void;
}): TuiHandle {
  const instance = render(
    <DevTui
      store={options.store}
      keys={options.keys}
      onRestart={options.onRestart}
      onOpen={options.onOpen}
      onLogin={options.onLogin}
      onSignIn={options.onSignIn}
      onAutostart={options.onAutostart}
      onDigit={options.onDigit}
      onQuit={options.onQuit}
      onInterrupt={options.onInterrupt}
    />,
    { exitOnCtrlC: false, patchConsole: false },
  );
  return {
    store: options.store,
    stop: async () => {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}
