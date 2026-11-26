import { Suspense } from "react";
import { authalla } from "@/lib/authalla";
import { signOutAction } from "./actions";

// A Server Component reading the session. It reads cookies, so it sits in
// <Suspense> and the rest of the page is prerendered.
async function Greeting() {
  const session = await authalla.auth();
  if (!session) {
    return (
      <p>
        You&apos;re signed out. <a href={authalla.signInUrl({ returnTo: "/account" })}>Sign in</a> or{" "}
        <a href={authalla.signInUrl({ prompt: "create" })}>create an account</a>.
      </p>
    );
  }
  return (
    <>
      <p data-testid="greeting">Hello, {session.user.name ?? session.user.email}.</p>
      <form action={signOutAction}>
        <button type="submit">Sign out (Server Action)</button>
      </form>
    </>
  );
}

export default function Home() {
  return (
    <main>
      <h1>Authalla + Next.js</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <Greeting />
      </Suspense>
    </main>
  );
}
