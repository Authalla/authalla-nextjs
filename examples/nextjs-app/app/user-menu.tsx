"use client";

import { useAuth } from "@authalla/nextjs/client";

// A Client Component. With suspense it waits for the session inside the
// layout's <Suspense>, so it never flashes a loading state.
export function UserMenu() {
  const { status, user, signIn, signOut, sessionEnded, signInError } = useAuth({ suspense: true });
  if (status !== "signed-in") {
    return (
      <>
        {sessionEnded && <span>Your session ended. </span>}
        {signInError && signInError.prompt !== "passkey" && <span>Sign-in didn&apos;t finish ({signInError.code}). </span>}
        <button onClick={() => signIn()}>Sign in</button>
      </>
    );
  }
  return (
    <>
      <span data-testid="user-menu">{user?.name ?? user?.email} </span>
      <button onClick={() => signIn({ prompt: "login" })}>Sign in again</button>{" "}
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}
