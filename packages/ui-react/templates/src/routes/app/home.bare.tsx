import { useEffect, useState } from "react";

// Your screen. Pithy wrote this file once and never will again — everything under src/routes/app/ is
// yours. Add a screen by dropping a file in beside it with its own `path` export.
export const path = "/";

/** What GET /health answers. Every Pithy worker serves it. */
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
    fetch("/health", { credentials: "include" })
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
