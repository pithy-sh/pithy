import { Hono } from "hono";
import type { BindingSpec } from "./capability/bindings";
import type { Capability, PithyHonoEnv } from "./capability/capability";
import { validateBindings } from "./capability/validateBindings";
import { pithyErrorHandler } from "./error/http";

/** Inputs to {@link createBackend}: the capabilities to assemble, plus the app's own capability. */
export interface CreateBackendOptions {
  /** Library capabilities (core + each `@pithy-sh/*`), composed in order. */
  capabilities: Capability[];
  /**
   * The app itself, as a `Capability` — principle 4: the app is just another capability. Its
   * middleware, routes, and bindings compose with the rest; its routes mount last.
   */
  app?: Capability;
}

/**
 * Assemble capabilities into a deployable Hono app — a valid Worker `fetch` handler.
 *
 * Serves `GET /health`, validates that every required binding is present, composes each
 * capability's middleware, and mounts the capability (then app) routes. `PithyError`s become
 * their declared HTTP status via {@link pithyErrorHandler}.
 *
 * Binding validation runs **once on the first request**, not at module load: in Workers `env`
 * is per-request, so there is no env to check until a request arrives. The result is memoized,
 * so the cost is paid once for the lifetime of the isolate.
 */
export function createBackend(options: CreateBackendOptions): Hono<PithyHonoEnv> {
  // The app is just another capability, composed last so its routes mount after the libraries'.
  const all: Capability[] = options.app ? [...options.capabilities, options.app] : options.capabilities;
  const required: BindingSpec[] = all.flatMap((cap) => cap.requiredBindings);

  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);

  let validated = false;
  app.use("*", async (c, next) => {
    if (!validated) {
      validateBindings(c.env as Record<string, unknown>, required);
      validated = true;
    }
    // Seed the request context. A capability reads these handles; a strategy may overwrite `auth`.
    if (c.get("auth") === undefined) c.set("auth", null);
    if (c.get("db") === undefined) c.set("db", null);
    if (c.get("kv") === undefined) c.set("kv", null);
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  for (const cap of all) {
    for (const middleware of cap.middleware ?? []) middleware(app);
  }
  for (const cap of all) {
    cap.routes?.(app);
  }

  return app;
}
