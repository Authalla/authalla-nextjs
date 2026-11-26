import { authalla } from "@/lib/authalla";

// Refreshes the tokens before a page renders.
export const proxy = authalla.proxy;
export const config = { matcher: ["/((?!api/|_next/|.*\\..*).*)"] };
