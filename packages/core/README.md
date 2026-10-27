# @pithy-sh/core

The contract every Pithy capability composes through, and the seams they share: `defineCapability` and `createBackend`, the `PithyError` family, the D1 and KV codecs, the `AuthContext`, translator, audit and entitlement seams, the control-plane seam, and presence rooms.

**Documentation: [pithy.sh/docs](https://pithy.sh/docs).** The control-plane seam is [`docs/CONTROL-PLANE.md`](../../docs/CONTROL-PLANE.md); sockets are [`docs/SOCKETS.md`](../../docs/SOCKETS.md).

## Presence rooms

Who else has a record open, live, from your own Worker. A capability declares its room kinds on `presence`:

```ts
defineCapability({
  name: "support",
  presence: {
    basePath: "/support",
    ticketKey: (env) => readTicketKey(env), // presence-ticket-key, through @pithy-sh/secrets
    rooms: [
      {
        kind: "support.thread",
        scope: "support:threads:read",
        activities: ["viewing", "replying"],
        session: (c, recordId) => (canRead(c, recordId) ? { name: displayName(c) } : null),
      },
    ],
  },
  // …
});
```

At runtime that is the whole of the wiring: `defineCapability` adds the `PRESENCE_ROOMS` Durable Object binding and the room socket, `createBackend` mounts the routes under `basePath`, and the control-plane manifest lists the kind. The CLI does not read your code, though. A kit capability's `pithy.manifest.json` must list the binding in `requiredBindings` exactly as `PRESENCE_ROOMS_BINDING_SPEC` gives it, beside the `presence-ticket-key` entry in `devSecrets`, because that manifest is what `pithy add` and `pithy upgrade` wire. Leave it out and `pithy add` writes no binding, no class migration and no entry export, and the Worker has no room to open. Only your own `app` capability, which has no manifest, is wired from its composition by `pithy upgrade`.

```json
"requiredBindings": [
  {
    "type": "durable_object",
    "name": "PRESENCE_ROOMS",
    "className": "PresenceRoom",
    "classModule": "@pithy-sh/core/src/presence/durableObject"
  }
]
```

- **Tickets.** A management client mints one at `POST /control-plane/presence/tickets` with the kind's own scope. A signed-in user mints one at `POST {basePath}/presence/tickets`, when `session` admits them. Single use, 60 seconds, one room, one participant.
- **The socket.** `GET {basePath}/presence/rooms/:kind/:recordId`, offering `pithy.presence.v1` and `pithy.ticket.<ticket>` in `Sec-WebSocket-Protocol`. `init` first, then `joined`, `left` and `activity`. Send `set_activity` with a declared activity, and `ping` for `pong`.
- **The ticket key.** `presence-ticket-key`, declared in the capability's `@pithy-sh/secrets` registry with `PRESENCE_TICKET_KEY_ENTRY` and listed in its manifest's `devSecrets`. Nobody chooses its value: `pithy add` mints the local one and `pithy secrets provision` the deployed ones.
- **The room** is one hibernating `PresenceRoom` per record. It holds nothing but who is here, in its sockets' attachments, and writes nothing to D1, KV or storage.

Ticket, participant and frame schemas are exported from `@pithy-sh/core/src/presence/http/responses`, `@pithy-sh/core/src/presence/http/schemas` and `@pithy-sh/core/src/presence/frames`.

`pithy add` and `pithy upgrade` write the binding, the class migration tag and this line into your Worker's entry:

```ts
export { PresenceRoom } from "@pithy-sh/core/src/presence/durableObject";
```
