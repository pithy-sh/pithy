import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

/**
 * Call `onActive` each time the app comes back to the foreground: after a checkout in the system browser, or a
 * trip to the store's subscription settings, the screen reads the subscription again rather than show what it
 * read before the reader left. Not on the first render; the screen's own read covers that.
 */
export function useAppFocus(onActive: () => void): void {
  const latest = useRef(onActive);
  latest.current = onActive;
  useEffect(() => {
    let previous: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next) => {
      if (previous !== "active" && next === "active") latest.current();
      previous = next;
    });
    return () => subscription.remove();
  }, []);
}
