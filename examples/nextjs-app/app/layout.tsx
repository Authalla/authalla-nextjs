import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthallaProvider } from "@authalla/nextjs/client";
import { authalla } from "@/lib/authalla";
import { UserMenu } from "./user-menu";

export const metadata: Metadata = { title: "Authalla + Next.js" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui", maxWidth: 720, margin: "0 auto", padding: 24 }}>
        {/* The promise, not awaited: the layout stays prerenderable. */}
        <AuthallaProvider session={authalla.clientSession()}>
          <nav style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 24 }}>
            <Link href="/">Home</Link>
            <Link href="/account">Account</Link>
            <Link href="/passkeys">Passkeys</Link>
            <span style={{ marginLeft: "auto" }}>
              <Suspense fallback={<span>…</span>}>
                <UserMenu />
              </Suspense>
            </span>
          </nav>
          {children}
        </AuthallaProvider>
      </body>
    </html>
  );
}
