import { Suspense } from "react";
import { authalla } from "@/lib/authalla";
import { Passkeys } from "./passkeys";

async function SignedInOnly({ children }: { children: React.ReactNode }) {
  await authalla.requireSession("/passkeys");
  return children;
}

export default function PasskeysPage() {
  return (
    <main>
      <h1>Passkeys</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <SignedInOnly>
          <Passkeys />
        </SignedInOnly>
      </Suspense>
    </main>
  );
}
