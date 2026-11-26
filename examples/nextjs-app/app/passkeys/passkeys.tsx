"use client";

import { useEffect, useState } from "react";
import { useAuth, UserApiError, type Passkey } from "@authalla/nextjs/client";

// The User API from the browser, through the app's route handler.
export function Passkeys() {
  const { userApi, addPasskey, signInError } = useAuth();
  const [passkeys, setPasskeys] = useState<Passkey[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    userApi
      .listPasskeys()
      .then(setPasskeys)
      .catch((err) => setError(err instanceof UserApiError ? err.message : String(err)));
  }, [userApi]);

  return (
    <section>
      {signInError?.prompt === "passkey" && <p>No passkey added. You can add one any time.</p>}
      {error && <p role="alert">{error}</p>}
      {passkeys === undefined ? (
        <p>Loading…</p>
      ) : (
        <ul data-testid="passkeys">
          {passkeys.length === 0 && <li>No passkeys yet.</li>}
          {passkeys.map((p) => (
            <li key={p.id}>
              {p.name ?? p.authenticator ?? "Passkey"}, added {new Date(p.created_at).toLocaleDateString()}
            </li>
          ))}
        </ul>
      )}
      <button onClick={() => addPasskey({ returnTo: "/passkeys" })}>Add a passkey</button>
    </section>
  );
}
