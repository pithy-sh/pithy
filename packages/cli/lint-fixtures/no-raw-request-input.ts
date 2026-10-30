// Matched: every raw accessor, on any object, with type arguments, across lines.
c.req.param("id");
c.req.query();
c.req.json();
this.req.json();
a.b.req.param("y");
c.req.json<Body>();
c.req.param<"id">("id");
c.req
  .param("id");
// Not matched: the validated reader, the other accessors, a bare req, optional chains, parenthesized.
c.req.valid("json");
c.req.header("x");
c.req.raw;
req.param("x");
c.req.json?.();
c?.req.json();
c.req?.json();
(c.req).json();
