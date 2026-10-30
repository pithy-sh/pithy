// Matched: the call, the reference, either name, a bound method.
z.config({});
zod.config;
queueMicrotask(z.config);
z.config.bind(z);
// Not matched: another object's, optional, parenthesized, a written target.
x.z.config();
z?.config();
(z).config;
z.config = () => {};
