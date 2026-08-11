---
"@pithy-sh/cli": minor
---

Key rotation goes through the seam that enforces it.

The control plane has exposed `POST {basePath}/keys` since it shipped — `requireControlPlane(KEYS_ROTATE_SCOPE)`, signed with the key it replaces, audited on the adopter's own side. `pithy dashboard rotate` did not use it. It opened the adopter's D1 through `openConnectionRegistry` and wrote the same `keys` column the route governs.

Not duplicated logic: both paths call core's `appendKey`, so the ordering rules were always shared. A duplicated **authority**. The safety property lived in a function rather than at a boundary, so it held for callers who remembered to use it and for nobody else — and three things followed only from the route. The grant was never checked, so a connection with no `keys:rotate` rotated anyway. The adopter's trail recorded nothing, on the one change that decides who may call them. And the CLI needed D1 write access to do ordinary work.

**`rotate` now asks the management client to register the successor at the adopter's Worker**, sending the seam's address from the adopter's own row rather than trusting the client's memory of it. The CLI writes nothing. A Worker that cannot be reached fails the rotation and changes nothing, where the old path wrote the key locally, failed the ping, and left the two sides disagreeing about which keys existed.

**One rule replaces the convention**, stated as a property and enforced in the registry rather than at its call sites:

> The CLI adds a key to a connection only when no live key exists to sign for one through the seam.

That is first connect — nothing can sign, and the Worker may not be deployed at all, so requiring a running Worker to register the key that lets anyone talk to it would be a chicken-and-egg with no exit. The same sentence covers recovery from a connection whose every key was revoked, because it is the same fact. `connectionRegistry.appendKey` refuses while anything is live, `save` may create or replace a connection but never rewrite the keys of one it is keeping, and a test asserts that no other module in the CLI opens that table at all. Revocation stays outside it deliberately: it removes trust, and revocation needing the Worker's cooperation would not be revocation.

`connect --public-key` therefore registers a first key and refuses a successor while one is live, printing the call to make instead — the CLI holds no private half and cannot sign for you. Re-offering the key already registered is now an address re-point rather than a duplicate-id error, which is what that path needed to stay usable.

**Two contract changes for management clients.**

- `rotateKey(token, connectionId, address)` takes the seam's address and returns `{ keyId, validFrom }` — no key material, because the CLI no longer writes the key. Implementations must register at `POST {basePath}/keys`, signed with the key being replaced, and must fail rather than report a key they did not register.
- `ConnectionHealth` gains a required, nullable `keyId`: which key answered the `ping`. **This is what proves a rotation.** The seam echoes the verifying key precisely so a client can tell which one answered, and a rotation is reported connected only when that is the new key — a ping answered by the key being replaced proves the connection, not the successor the next step would expire the old one on the strength of.

That check was first written as a re-read of the adopter's row and the end-to-end run refuted it: locally the CLI's D1 handle and the Worker's are two runtimes, so a registration the Worker had just committed was invisible to a reader that had already opened the file — a correct rotation failing on a stale read, in the environment everybody tries first.

`docs/CONTROL-PLANE.md` §15 now names every operation, where its write happens, and why exactly one is exempt.
