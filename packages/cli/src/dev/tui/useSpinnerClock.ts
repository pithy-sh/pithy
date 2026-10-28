// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";
import { SPINNER_INTERVAL_MS } from "./footer";

/**
 * The time the spinner draws from, re-read every {@link SPINNER_INTERVAL_MS} while `moving` and frozen otherwise.
 * A command left open all day should not be redrawing a clock into somebody's battery, so once nothing is moving the
 * footer is static until the next event moves it.
 */
export function useSpinnerClock(moving: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!moving) return;
    const id = setInterval(() => setNow(new Date()), SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [moving]);
  return now;
}
