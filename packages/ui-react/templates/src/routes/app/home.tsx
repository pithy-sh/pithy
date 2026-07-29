import { signOut, useSession } from "../../session";

// Your screen. Pithy wrote this file once and never will again — everything under src/routes/app/ is
// yours. Add a screen by dropping a file in beside it with its own `path` export.
export const path = "/";

// Signed-out visitors are sent to /sign-in. Delete this line to make the screen public.
export const session = "required";

export default function Home() {
  const { session: current } = useSession();

  return (
    <main className="screen">
      <h1>You're in.</h1>
      <p className="muted">Signed in as {current?.user.email ?? "someone"}.</p>
      <div className="stack">
        <button type="button" className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </main>
  );
}
