// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Redirect } from "./redirect";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function render(node: ReactNode): void {
  root ??= createRoot(document.createElement("div"));
  act(() => root?.render(node));
}

describe("Redirect", () => {
  test("navigates once on render, pushing by default", () => {
    const go = vi.fn();
    render(<Redirect to="/sign-in" go={go} />);
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith("/sign-in", { replace: false });
  });

  test("honors replace", () => {
    const go = vi.fn();
    render(<Redirect to="/paywall" replace go={go} />);
    expect(go).toHaveBeenCalledWith("/paywall", { replace: true });
  });

  test("navigates once under StrictMode", () => {
    const go = vi.fn();
    render(
      <StrictMode>
        <Redirect to="/sign-in" go={go} />
      </StrictMode>,
    );
    expect(go).toHaveBeenCalledTimes(1);
  });

  test("a re-render to the same place navigates nothing more, and a new place navigates again", () => {
    const go = vi.fn();
    render(<Redirect to="/a" go={go} />);
    render(<Redirect to="/a" go={() => go("other")} />);
    expect(go).toHaveBeenCalledTimes(1);
    render(<Redirect to="/b" go={go} />);
    expect(go).toHaveBeenLastCalledWith("/b", { replace: false });
  });

  test("renders nothing", () => {
    const host = document.createElement("div");
    root = createRoot(host);
    act(() => root?.render(<Redirect to="/x" go={() => undefined} />));
    expect(host.innerHTML).toBe("");
  });
});
