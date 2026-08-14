---
"@pithy-sh/core": minor
"@pithy-sh/support": minor
---

Publish a reader's contract beside every management projection, so a client survives an enum member it has never heard of.

One schema per projection has served two consumers with different obligations. A Worker validating its own projection is checking itself and must be strict — `SupportChannel` is what `inbound/` branches on and what D1 holds, and a tolerated-unknown member there would license a capability to store a channel it cannot handle. A management client reading that response is crossing a trust boundary: the Worker is a fork, a bug, a half-finished deploy, or hostile, and one unrecognised member cost it the whole response. `pithy-sh/dashboard#15` rendered zero of twenty-five conversations for exactly one such token, and the client that fixed it had to hold a widened copy of our shape — the mirror `#113` exists to forbid.

`asRead` from `@pithy-sh/core/src/projection/asRead` is the pattern, stated once for the kit: the producer's object with every enum reachable through it read as a string, every other field the **identical schema instance**, and every description carried over with a sentence saying what the field now permits. It is not a loosening — a missing field, a wrong type, a number outside its bounds, a body that is not an object all still refuse the whole response. It is not a mapping — the token comes back verbatim, and the enum stays the authority a client asks. And it is not selective: a reader does not control the writer, so widening two enums and leaving a third is how the same blank pane returns one field over. A shape `asRead` cannot see through — a union, a record, a tuple, an object with its own unknown-key rule — throws at construction rather than passing through unrewritten.

`@pithy-sh/support` publishes six: `SupportThreadViewAsRead`, `SupportListedThreadViewAsRead`, `SupportMessageViewAsRead`, `SupportThreadsResponseAsRead`, `SupportThreadResponseAsRead`, `SupportArchiveResponseAsRead`. The producers are untouched and still refuse what they always refused; a test asserts both halves over the same field, and a gate walks each published contract for an enum it failed to widen, against a producer proved to hold one. The submitter's own views stay strict — an app reading its own Worker is not reading a stranger.

Closes the local widening in `pithy-sh/dashboard`, which was filed as a stopgap.
