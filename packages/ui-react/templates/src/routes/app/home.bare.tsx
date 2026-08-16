import { HEALTH_PATH } from "@pithy-sh/core/src/worker/health";
import { useEffect, useState } from "react";

// Your screen. Pithy wrote this file once and never will again — everything under src/routes/app/ is
// yours. Add a screen by dropping a file in beside it with its own `path` export.
export const path = "/";

/** What the health route answers. Every Pithy worker serves it. */
interface Health {
  status: string;
}

function isHealth(value: unknown): value is Health {
  return typeof value === "object" && value !== null && typeof (value as { status?: unknown }).status === "string";
}

export default function Home() {
  const [status, setStatus] = useState("checking");

  useEffect(() => {
    let live = true;
    // Same origin. The SPA and the worker are one deploy on one origin, so paths are relative and
    // there is no CORS config and no API origin variable — in dev or in production.
    //
    // **No cookie mode, and that is the whole of the request's security story.** The health route is
    // public: it reads nothing about you, so there is no session to send it, and this is the one screen
    // a project with no auth composed still gets. Every request that *does* carry a session goes through
    // `@pithy-sh/auth/src/client/api` instead — which is not importable from here, and does not need to
    // be, because a request with no ambient credential on it is not the rule that primitive exists to
    // own (#370).
    //
    // **`HEALTH_PATH`, not a string.** The worker mounts this route from that same constant. A copy
    // here would go stale the day it moves and render "The worker says: unknown." — a 200, no error,
    // nothing in a log (#400). It is yours to change; changing it to a literal is the way to lose that.
    fetch(HEALTH_PATH)
      .then((response) => response.json())
      .then((body: unknown) => {
        if (live) setStatus(isHealth(body) ? body.status : "unknown");
      })
      .catch(() => {
        if (live) setStatus("unreachable");
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="screen">
      <h1>It runs.</h1>
      <p className="muted">The worker says: {status}.</p>
    </main>
  );
}
