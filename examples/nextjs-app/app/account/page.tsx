import { Suspense } from "react";
import { authalla } from "@/lib/authalla";
import { updateName } from "./actions";

async function Profile() {
  // Signed out: off to sign-in, and back here afterwards.
  await authalla.requireSession("/account");
  const me = await authalla.userApi.getMe();
  return (
    <>
      <p data-testid="profile">
        {me.name} · {me.email} {me.email_verified ? "(verified)" : ""}
      </p>
      <form action={updateName}>
        <label>
          Name <input name="name" defaultValue={me.name} />
        </label>{" "}
        <button type="submit">Save</button>
      </form>
    </>
  );
}

export default function Account() {
  return (
    <main>
      <h1>Account</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <Profile />
      </Suspense>
    </main>
  );
}
