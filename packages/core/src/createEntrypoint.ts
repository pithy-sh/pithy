import type { Capability, CapabilityEmailHandler } from "./capability/capability";
import { type CreateBackendOptions, createBackend } from "./createBackend";

/**
 * A deployable Worker entrypoint: `fetch` plus the single inbound `email` handler the runtime
 * permits per Worker. `createBackend` already produces the `fetch` side (a Hono app); this wraps it
 * and composes every capability's inbound-email handler behind one `email()` entry, so a Worker that
 * mounts `@pithy-sh/email` receives bounce/complaint mail without the user authoring a handler.
 */
export interface PithyEntrypoint {
  /** The Worker `fetch` handler — the composed Hono app. */
  fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) => Response | Promise<Response>;
  /**
   * The Worker `email` handler — fans each incoming message to every capability that declares one.
   * **Present only when at least one capability handles inbound mail.** Omitted otherwise, so a Worker
   * that no capability wired for email doesn't expose a no-op `email()` that would silently *drop* any
   * message routed to it (an exported-but-inert handler consumes the message without forwarding or
   * rejecting it).
   */
  email?: (message: ForwardableEmailMessage, env: Record<string, unknown>, ctx: ExecutionContext) => Promise<void>;
}

/**
 * The raw MIME stream of a `ForwardableEmailMessage` is **single-use** — once one handler reads it,
 * the next sees an empty stream. When more than one capability handles inbound mail we buffer the
 * body once and hand each handler a proxy whose `raw` yields a fresh stream over that buffer; every
 * other property/method delegates to (and stays bound to) the real message.
 */
function replayable(message: ForwardableEmailMessage, raw: ArrayBuffer): ForwardableEmailMessage {
  return new Proxy(message, {
    get(target, prop, receiver) {
      if (prop === "raw") return new Response(raw.slice(0)).body as ReadableStream<Uint8Array>;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Assemble capabilities into a Worker entrypoint object — `{ fetch, email }`. Use this instead of
 * `createBackend` directly when any capability handles inbound email (e.g. `@pithy-sh/email`'s bounce
 * handler). `fetch` is the same Hono app `createBackend` returns; `email` fans each incoming message
 * to every capability's `email` handler, replaying the single-use raw stream so each sees the full
 * message. Handlers run sequentially in registration order.
 */
export function createEntrypoint<
  const Caps extends readonly Capability[],
  const App extends Capability = Capability<Record<never, never>, Record<never, never>>,
>(options: CreateBackendOptions<Caps, App>): PithyEntrypoint {
  const app = createBackend(options);
  const all: Capability[] = options.app ? [...options.capabilities, options.app] : [...options.capabilities];
  const handlers: CapabilityEmailHandler[] = all.flatMap((cap) => (cap.email ? [cap.email] : []));

  const entrypoint: PithyEntrypoint = { fetch: (request, env, ctx) => app.fetch(request, env, ctx) };

  // Only expose an `email` handler when something actually handles inbound mail — an inert one would
  // silently drop any message Email Routing delivered to this Worker.
  if (handlers.length > 0) {
    entrypoint.email = async (message, env, ctx) => {
      if (handlers.length === 1) {
        await handlers[0]?.(message, env, ctx);
        return;
      }
      // Multiple consumers: buffer the raw body once, then replay it per handler.
      const raw = await new Response(message.raw).arrayBuffer();
      for (const handler of handlers) {
        await handler(replayable(message, raw), env, ctx);
      }
    };
  }
  return entrypoint;
}
