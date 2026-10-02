// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { render } from "ink-testing-library";
import { describe, expect, test, vi } from "vitest";
import { stripAnsi } from "../logging";
import { Footer, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "./footer";
import type { SessionState } from "./session";

/**
 * **The rendered footer, as frames rather than as intent.**
 *
 * `roster.ts` decides the words and the columns and is tested directly; this file covers the part only a
 * render can answer — that the rows reach the frame, that the saffron spinner lands on the building row
 * and nowhere else, and that the dev-login line says the email and never a claim.
 */

const at = (ms: number) => new Date(1_700_000_000_000 + ms);

const state: SessionState = {
  workers: [
    { name: "api", kind: "app", port: 8787, spawnedAt: at(0), status: "ready", readyMs: 1900 },
    { name: "email", kind: "host", port: 8789, spawnedAt: at(0), status: "building" },
  ],
  login: { count: 1, email: "ada@example.com" },
  sessionReady: false,
};

/**
 * The frame, with color stripped — color has its own assertions below.
 *
 * Through `dev/logging.ts`'s `stripAnsi`, which is the repository's one ANSI regex: a second copy here
 * would need the same `noControlCharactersInRegex` suppression and would be a second thing to get right.
 */
const plain = (frame: string | undefined) => stripAnsi(frame ?? "");

describe("Footer", () => {
  test("every worker is a row carrying its port and state", () => {
    const { lastFrame } = render(<Footer state={state} now={at(14_000)} columns={80} keys={[]} selected={0} />);
    const frame = plain(lastFrame());
    expect(frame).toContain("api");
    expect(frame).toContain("8787");
    expect(frame).toContain("ready");
    expect(frame).toContain("email");
    expect(frame).toContain("8789");
    expect(frame).toContain("building");
  });

  test("there is no dev-login line — the key bar carries that fact", () => {
    // It said `Dev login: <email>`, then `Dev login: 29 identities`, and in both forms the only thing it
    // added over `l login` on the bar was *something is seeded*. The bar says that by `l` being live
    // rather than dim, and a row of prose under a table that answers the question is a row of prose.
    const { lastFrame } = render(<Footer state={state} now={at(0)} columns={80} keys={[]} selected={0} />);
    expect(plain(lastFrame())).not.toContain("Dev login");
  });

  test("no seeded identity means no dev-login line at all, not an empty one", () => {
    const { lastFrame } = render(
      <Footer state={{ ...state, login: { count: 0, email: null } }} now={at(0)} columns={80} keys={[]} selected={0} />,
    );
    expect(plain(lastFrame())).not.toContain("Dev login");
  });

  test("the selected row is marked, and only one row is", () => {
    const { lastFrame } = render(<Footer state={state} now={at(0)} columns={80} keys={[]} selected={1} />);
    const lines = plain(lastFrame()).split("\n");
    const marked = lines.filter((l) => l.startsWith("▸"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("email");
  });

  test("the spinner glyph lands on the building row and nowhere else", () => {
    const { lastFrame } = render(<Footer state={state} now={at(14_000)} columns={80} keys={[]} selected={0} />);
    const lines = plain(lastFrame()).split("\n");
    const spinning = lines.filter((l) => SPINNER_FRAMES.some((g) => l.includes(g)));
    expect(spinning).toHaveLength(1);
    expect(spinning[0]).toContain("email");
  });

  test("the spinner frame advances with the clock, so the glyph is a function of its props", () => {
    const frameAt = (ms: number) => {
      const { lastFrame } = render(<Footer state={state} now={at(ms)} columns={80} keys={[]} selected={0} />);
      return SPINNER_FRAMES.find((g) => plain(lastFrame()).includes(g));
    };
    expect(frameAt(0)).toBeDefined();
    expect(frameAt(0)).not.toBe(frameAt(SPINNER_INTERVAL_MS));
  });

  test("the key bar renders the keys it is given", () => {
    const { lastFrame } = render(
      <Footer
        state={state}
        now={at(0)}
        columns={80}
        keys={[
          { key: "r", label: "restart", enabled: true },
          { key: "q", label: "quit", enabled: true },
        ]}
        selected={0}
      />,
    );
    expect(plain(lastFrame())).toContain("r restart   q quit");
  });

  test("no keys means no bar — a session with nothing to press shows no hint", () => {
    const { lastFrame } = render(<Footer state={state} now={at(0)} columns={80} keys={[]} selected={0} />);
    expect(plain(lastFrame())).not.toContain("quit");
  });

  test("an empty session renders nothing rather than an empty rule", () => {
    const { lastFrame } = render(
      <Footer
        state={{ workers: [], login: { count: 0, email: null }, sessionReady: false }}
        now={at(0)}
        columns={80}
        keys={[]}
        selected={0}
      />,
    );
    expect(plain(lastFrame()).trim()).toBe("");
  });
});

/**
 * **The one color claim worth a re-import.** Every other test here runs under the suite's `NO_COLOR=1`
 * (vitest.config.ts) so it asserts words rather than escape sequences — which is the right default, and
 * is why `terminal/style.ts` latches `enabled` at import. §3.4 licenses saffron for a spinner glyph and
 * for nothing else in this footer, so that specific claim is checked with color genuinely on, the way
 * `style.test.ts` checks the tiers themselves.
 */
describe("Footer color", () => {
  test("the spinner is painted saffron, and it is the only truecolor in the frame", async () => {
    vi.resetModules();
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("COLORTERM", "truecolor");
    try {
      const { Footer: Painted, SPINNER_FRAMES: frames } = await import("./footer");
      const { render: renderPainted } = await import("ink-testing-library");
      const { lastFrame } = renderPainted(
        <Painted state={state} now={at(14_000)} columns={80} keys={[]} selected={0} />,
      );
      const frame = lastFrame() ?? "";
      const glyph = frames.find((g) => frame.includes(g));
      expect(glyph).toBeDefined();
      // #D4A017, the one truecolor §3.4 defines, applied exactly once.
      expect(frame.split("38;2;212;160;23").length - 1).toBe(1);
      expect(frame).toContain(`38;2;212;160;23m${glyph}`);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
