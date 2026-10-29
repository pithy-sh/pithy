// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from "react";

/** What {@link Redirect} takes. */
export interface RedirectProps {
  /** Where to go. */
  readonly to: string;
  /** Replace the current history entry rather than push one. For a correction the reader did not make. */
  readonly replace?: boolean | undefined;
  /** How this app navigates. A scaffolded router binds its own. */
  readonly go: (to: string, options: { replace: boolean }) => void;
}

/**
 * Go somewhere else, as one of the states a screen renders: the way it renders loading and failure, it renders
 * this when the answer means "not here". It navigates once after the render commits, StrictMode's second effect
 * pass included, and renders nothing.
 */
export function Redirect({ to, replace = false, go }: RedirectProps): null {
  const latest = useRef(go);
  latest.current = go;
  const gone = useRef<string | null>(null);

  useEffect(() => {
    const target = `${replace ? "replace" : "push"} ${to}`;
    if (gone.current === target) return;
    gone.current = target;
    latest.current(to, { replace });
  }, [to, replace]);

  return null;
}
