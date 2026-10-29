import { Slot } from "expo-router";
import { type ReactNode, StrictMode } from "react";
import { PithyLocale } from "../src/pithy-locale";
import { storeTransactions } from "../src/route-modules";

/**
 * The app's root: one language over every screen, and the route `expo-router` resolved. Every path lands on
 * `[...pithy].tsx` or `index.tsx`, which hand it to the kit's router, so screens register by dropping a file into
 * `src/routes/`, exactly as they do in the React app.
 *
 * With the payments screens written, the store's listener runs here for the whole launch, so a purchase the store
 * hands back at launch reaches the account before any screen asks for it.
 *
 * Your own catalogs go on `<PithyLocale messages={{ fr: … }}>`.
 */
export default function Layout(): ReactNode {
  return (
    <StrictMode>
      {storeTransactions && <StoreTransactions listen={storeTransactions} />}
      <PithyLocale>
        <Slot />
      </PithyLocale>
    </StrictMode>
  );
}

/** Runs the store listener. A component of its own, so the layout calls the hook only when it was written. */
function StoreTransactions(props: { listen: () => void }): ReactNode {
  props.listen();
  return null;
}
