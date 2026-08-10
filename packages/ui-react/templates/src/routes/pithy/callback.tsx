import { useEffect } from "react";
import { navigate } from "../../router";
import { getSession } from "../../session";
import "../../pithy-screens.css";

export const path = "/callback";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.

export default function Callback() {
  useEffect(() => {
    // The session cookie is already set by the time we get here — the server did the verifying.
    // This screen just asks who you are and moves on.
    void getSession().then((current) => navigate(current ? "/" : "/sign-in"));
  }, []);

  return (
    <main className="screen">
      <h1>Signing you in.</h1>
      <p className="muted">One moment.</p>
    </main>
  );
}
