import { createAuthalla } from "@authalla/nextjs";

export const authalla = createAuthalla({
  // The defaults, plus the User API scopes this app's pages use.
  scopes: ["openid", "profile", "email", "offline_access", "passkeys:read", "passkeys:write"],
});
