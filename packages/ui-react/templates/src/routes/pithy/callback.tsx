import { useEffect } from "react";
import { navigate, routeTable, screenPath } from "../../router";
import { getSession } from "../../session";
import "../../pithy-screens.css";

export const path = "/callback";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// `sign-in.tsx` builds the magic link's `callbackURL` from the `path` above, so renaming it moves both
// ends at once. That is the contract #393 exists for — the round trip is the one flow nobody already
// signed in can test, so it must not be two strings that only happen to agree.

export default function Callback() {
  useEffect(() => {
    // The session cookie is already set by the time we get here — the server did the verifying.
    // This screen just asks who you are and moves on.
    //
    // Where "away" is comes from the route table, never a literal: the sign-in screen declares its own
    // path and claims the role, and this reads whatever it declared.
    void Promise.all([getSession(), routeTable()]).then(([current, table]) =>
      navigate(current ? "/" : screenPath(table, "sign-in")),
    );
  }, []);

  return (
    <main className="screen">
      <h1>Signing you in.</h1>
      <p className="muted">One moment.</p>
    </main>
  );
}
