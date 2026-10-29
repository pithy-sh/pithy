import { useEffect } from "react";
import { storeRailHere, watchStoreTransactions } from "./payments";

/**
 * Listen to the platform's store for as long as the app runs, and submit what it delivers with no screen waiting:
 * a purchase interrupted before it was finished, an approved Ask to Buy request, a renewal. Each is finished only
 * once the Worker has accepted it. Nothing on the web, or where this platform sells through no store.
 *
 * The root layout mounts it, so a purchase that lands at launch is on the account before any screen asks.
 */
export function useStoreTransactions(): void {
  useEffect(() => {
    const rail = storeRailHere();
    return rail === null ? undefined : watchStoreTransactions(rail);
  }, []);
}
