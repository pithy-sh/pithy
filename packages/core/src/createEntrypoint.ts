import type { Capability, CapabilityEmailHandler } from "./capability/capability";
import { type CreateBackendOptions, createBackend } from "./createBackend";
import { triggerWorkflow } from "./workflow/dispatch";
import { composeWorkflows, scheduledWorkflows } from "./workflow/register";

/**
 * A deployable Worker entrypoint: `fetch`, the single inbound `email` handler the runtime permits
 * per Worker, and the single `scheduled` handler it permits for cron triggers. `createBackend`
 * already produces the `fetch` side (a Hono app); this wraps it and composes every capability's
 * inbound-email handler and every cron-carrying durable job behind those two entries, so a Worker
 * that mounts `@pithy-sh/email` receives bounce/complaint mail — and fires its scheduler — without
 * the user authoring a handler.
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
  /**
   * The Worker `scheduled` handler — starts every registered job that declares a `schedule`.
   *
   * **Present only when at least one job carries a cron.** The reason differs from `email`'s: an
   * inert `email()` silently *drops* mail, which is a correctness bug, whereas an inert `scheduled()`
   * is merely harmless. It is omitted anyway so that the export tracks the composition: a Worker
   * mounting no scheduled job does not advertise a schedule it has none of.
   *
   * The converse does happen and is deliberate. A capability whose cron belongs to its *prebuilt host*
   * — `@pithy-sh/email`'s every-minute scheduler is the shipped example — still declares that schedule
   * on its spec, so an app worker composing it exports a `scheduled` handler while its own
   * `wrangler.jsonc` declares no `triggers.crons`. Nothing ever invokes it, and if something did, the
   * job's binding lives only on the host, so dispatch degrades with a logged warning. Deriving the
   * export from "does this deployment declare crons" is not available here: `createEntrypoint` sees
   * the composed capabilities, never the wrangler config.
   *
   * A cron is an *additional* entry point, never the only one: every scheduled job stays dispatchable
   * through `c.var.workflows.trigger(...)`, because a backfill nobody can run on demand cannot be
   * tested in staging.
   */
  scheduled?: (controller: unknown, env: Record<string, unknown>, ctx: ExecutionContext) => Promise<void>;
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

  const registry = composeWorkflows(all);
  const scheduled = scheduledWorkflows(registry);

  const entrypoint: PithyEntrypoint = { fetch: (request, env, ctx) => app.fetch(request, env, ctx) };

  // Cron-carrying jobs get the Worker's one `scheduled` entry. Each is started independently so one
  // job whose binding is missing cannot stop the rest of the schedule from running; the failure is
  // rethrown after the pass so the invocation is still recorded as failed.
  if (scheduled.length > 0) {
    entrypoint.scheduled = async (_controller, env) => {
      const failures: unknown[] = [];
      for (const entry of scheduled) {
        // A cron supplies no caller input, which is an *empty* parameter object, not an absent one —
        // `z.object({})` accepts `{}` and rejects `undefined`. A job whose schema requires fields it
        // can never receive on a schedule therefore fails loudly here, which is the author's bug and
        // is exactly what should surface.
        try {
          await triggerWorkflow(env, registry, entry.key, {});
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures[0] !== undefined) throw failures[0];
    };
  }

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
