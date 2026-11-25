// The link to the route handler's /signin, and reading it back. Shared by
// the server (signInUrl) and the browser (signIn), so it imports no code.

import type { SignInParams } from "./oauth.js";

export type SignInOptions = SignInParams & {
  /** The path to come back to after signing in. Default: the current page in the browser, / on the server. */
  returnTo?: string;
};

/** The path of /signin under basePath, with the options in its query. */
export function signInPath(basePath: string, options: SignInOptions = {}): string {
  const query = new URLSearchParams();
  if (options.returnTo) query.set("returnTo", options.returnTo);
  if (options.loginHint) query.set("login_hint", options.loginHint);
  if (options.uiLocales) query.set("ui_locales", options.uiLocales);
  if (options.prompt) query.set("prompt", options.prompt);
  if (options.maxAge !== undefined) query.set("max_age", String(options.maxAge));
  const search = query.toString();
  return `${basePath}/signin${search ? `?${search}` : ""}`;
}

/** The sign-in parameters from a /signin request's query. */
export function readSignInParams(query: URLSearchParams): SignInParams {
  const prompt = query.get("prompt");
  const maxAge = query.get("max_age");
  return {
    loginHint: query.get("login_hint") ?? undefined,
    uiLocales: query.get("ui_locales") ?? undefined,
    prompt: prompt === "create" || prompt === "login" || prompt === "passkey" ? prompt : undefined,
    maxAge: maxAge && /^\d+$/.test(maxAge) ? Number(maxAge) : undefined,
  };
}
