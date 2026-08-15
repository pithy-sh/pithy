---
"@pithy-sh/auth": minor
---

One sub-list that will not read costs its own pane, not the whole user page.

`GET {base}/admin/users/:userId` fanned three independent D1 reads out through `Promise.all` — sessions, devices, linked providers. One of them failing threw out of the handler and 500'd the request, so a support agent looking at an account that is already in trouble saw nothing at all: not the user, not the lists that did read.

Each read is guarded on its own now, and still concurrent — the guard is inside each arm. `AdminUserResponse`'s three lists are two-state values: `read` carries the rows and, where there is a bound, whether it cut them short; `unavailable` carries nothing. **An empty array means this user has none, and that is the distinction the flat shape could not make** — a pane rendering "no active sessions" over a list nobody read is telling a support agent something that was never established. The rows sit behind the state, so a client cannot reach them without narrowing.

The audit event records `null` rather than `0` for a list that did not read, for the same reason: the trail answers *how much did this caller see*, and a zero there is a claim about the user.

`getUser` stays unguarded. It is the subject of the pane, not a contributor to it, and its absence is still a 404.

**Nothing from the throw travels.** `unavailable` carries no reason — what a D1 read throws names a query and a table, and this response crosses a trust boundary to a management client.
