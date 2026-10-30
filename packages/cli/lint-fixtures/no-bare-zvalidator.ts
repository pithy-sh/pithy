// Matched: a bare call, with type arguments.
zValidator("json", S);
zValidator<string>("json", S);
app.post("/", zValidator("query", Q), handler);
// Not matched: a method of that name, a constructor, an optional call, the validated wrapper.
x.zValidator("json", S);
new zValidator();
zValidator?.("json", S);
validate("json", S);
