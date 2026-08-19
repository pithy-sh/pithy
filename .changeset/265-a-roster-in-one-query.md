---
"@pithy-sh/auth": minor
---

A list of user ids resolves in one query.

`admin/users.ts` could answer "this user" and "a page of users", and nothing in between. So every app composing auth that keeps its own membership or team table did one `getUser` per person to render a roster — and the alternatives were worse: reading `pithy_auth_users` directly is a second definition of somebody else's schema, and paging `listUsers` to find twelve people scans a table that grows without bound.

`getUsers(db, ids)` returns a `Map<string, User>`. A map because the caller already has the order — it is holding the id list — and what it lacks is the lookup; an array in input order would also quietly imply that a missing user leaves a hole in it.

A missing id is an absence, not an error: a membership can outlive the user row it names, and the pane has to render that gap rather than fail the screen. Duplicate ids collapse to one entry and one bound parameter. An empty list issues no query at all.

The list is bounded at `MAX_USER_LOOKUP`, and past it the call is refused with the cap named rather than truncated — answering for 100 of somebody's 140 members would be a wrong roster presented as a right one. The cap is 100 because two numbers meet there: it is D1's bound-parameter budget for a statement that binds nothing else, and it is `MAX_PAGE_SIZE`, so the largest page the kit hands out always resolves in one call.

Found while building the dashboard on the kit: its Team pane lists organization members, and every one of them needed a name.
