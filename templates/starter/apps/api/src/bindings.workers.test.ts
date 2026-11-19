import { env } from "cloudflare:test";
import { expect, test } from "vitest";

// The one test the scaffold ships, and it exists to prove the wiring rather than the code: a
// `*.workers.test.ts` file runs inside workerd with real bindings. Delete it once your own tests do.
//
// This is the kit's whole testing argument. A test that mocks D1 proves the mock works; a test against
// the real thing catches the SQL, the codec, and the binding name.

test("the Workers test project hands out a real D1 database", async () => {
  const { results } = await env.DB.prepare("select 1 as one").all<{ one: number }>();
  expect(results).toEqual([{ one: 1 }]);
});

test("and a real KV namespace", async () => {
  await env.SESSIONS.put("hello", "there");
  expect(await env.SESSIONS.get("hello")).toBe("there");
});

// A route behind requireAuth() is tested signed in, never stubbed: once auth is composed,
// signInTestUser from auth's src/test-utils/signIn signs a user in with a real session and hands
// back the headers to send.
//
//   const ada = await signInTestUser(env.DB, { email: "ada@example.com", secret: SESSION_SECRET });
//   const res = await app.request("/me", { headers: ada.headers }, env);
//   expect(res.status).toBe(200);
