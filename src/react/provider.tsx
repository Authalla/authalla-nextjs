"use client";

// The browser side: who is signed in, signing in and out, and the User API.
// It knows only what the route handler tells it; tokens stay on the server.
// Nothing here imports Next.js, so any React framework can use it.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ERROR_DESCRIPTION_PARAM, ERROR_PARAM, ERROR_PROMPT_PARAM } from "../core/constants.js";
import type { SignInParams } from "../core/oauth.js";
import type { ClientSession, SessionUser } from "../core/session.js";
import { createUserApi, UserApiError, type UserApi } from "../core/user-api.js";

export type SignInOptions = SignInParams & {
  /** The path to come back to after signing in. Default: the current page. */
  returnTo?: string;
};

/** A sign-in that came back without signing the user in. */
export type SignInError = {
  /** OAuth's error code: access_denied when the user cancelled. */
  code: string;
  description?: string;
  /** "passkey" when it was addPasskey() that didn't finish: access_denied then means Not now. */
  prompt?: "passkey";
};

export type AuthState = {
  status: "loading" | "signed-in" | "signed-out";
  user: SessionUser | undefined;
  /** Signed out because the session ended elsewhere (revoked, expired), not by signing out here. */
  sessionEnded: boolean;
  /** Set once after a sign-in that didn't finish, read from the address. */
  signInError: SignInError | undefined;
  /** Sends the browser to Authalla's sign-in. */
  signIn: (options?: SignInOptions) => void;
  /**
   * Sends the signed-in user to Authalla to add a passkey, then back with a
   * fresh session. A user who didn't sign in within five minutes signs in
   * first. Not now comes back as signInError { code: "access_denied", prompt: "passkey" }.
   */
  addPasskey: (options?: Omit<SignInOptions, "prompt" | "maxAge">) => void;
  /** Ends the grant and the Authalla session, then comes back signed out. */
  signOut: () => void;
  /** Reloads the session; with force, gets new tokens from Authalla first. */
  refresh: (options?: { force?: boolean }) => Promise<void>;
  /** The User API, called through the app's route handler with the session's token. */
  userApi: UserApi;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

type ProviderProps = {
  children: ReactNode;
  /**
   * The session from the server (`await authalla.clientSession()`), so the
   * first render is already right. Without it the provider fetches it.
   */
  session?: ClientSession;
  /** Where the route handler is mounted. Default: /api/auth. */
  basePath?: string;
};

export function AuthallaProvider({ children, session: initial, basePath = "/api/auth" }: ProviderProps) {
  const [session, setSession] = useState<ClientSession | undefined>(initial);
  const [signInError, setSignInError] = useState<SignInError>();
  const loading = useRef<Promise<void> | undefined>(undefined);

  // A newer server render (router.refresh(), a navigation) brings a newer
  // session; take it during render so the page and the hook agree.
  const [previousInitial, setPreviousInitial] = useState(initial);
  if (initial !== previousInitial) {
    setPreviousInitial(initial);
    if (initial) setSession(initial);
  }

  const load = useCallback(
    (force = false): Promise<void> => {
      if (!force && loading.current) return loading.current;
      const request = (async () => {
        try {
          const response = await fetch(`${basePath}/${force ? "refresh" : "session"}`, {
            method: force ? "POST" : "GET",
            cache: "no-store",
            credentials: "same-origin",
          });
          if (response.ok) setSession((await response.json()) as ClientSession);
        } catch {
          // Offline: keep what we have and try again on the next focus.
        } finally {
          loading.current = undefined;
        }
      })();
      loading.current = request;
      return request;
    },
    [basePath],
  );

  // Without a server session, fetch it. And whenever the tab comes back into
  // view, check again: the session may have ended while it was hidden, and
  // the check refreshes tokens that are about to expire.
  useEffect(() => {
    if (!initial) void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [initial, load]);

  // A sign-in that failed comes back with the error in the address. Read it
  // once, then take it out so a reload doesn't show it again.
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get(ERROR_PARAM);
    if (!code) return;
    // Reading the address after hydration is the point of this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSignInError({
      code,
      description: url.searchParams.get(ERROR_DESCRIPTION_PARAM) ?? undefined,
      prompt: url.searchParams.get(ERROR_PROMPT_PARAM) === "passkey" ? "passkey" : undefined,
    });
    url.searchParams.delete(ERROR_PARAM);
    url.searchParams.delete(ERROR_DESCRIPTION_PARAM);
    url.searchParams.delete(ERROR_PROMPT_PARAM);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);

  const signIn = useCallback(
    (options: SignInOptions = {}) => {
      const url = new URL(`${basePath}/signin`, window.location.href);
      url.searchParams.set("returnTo", options.returnTo ?? window.location.pathname + window.location.search);
      if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
      if (options.uiLocales) url.searchParams.set("ui_locales", options.uiLocales);
      if (options.prompt) url.searchParams.set("prompt", options.prompt);
      if (options.maxAge !== undefined) url.searchParams.set("max_age", String(options.maxAge));
      window.location.assign(url);
    },
    [basePath],
  );

  const addPasskey = useCallback(
    (options: Omit<SignInOptions, "prompt" | "maxAge"> = {}) => signIn({ ...options, prompt: "passkey" }),
    [signIn],
  );

  // A form post rather than fetch: the server answers with a redirect to
  // Authalla's logout, which the browser has to follow as a navigation.
  const signOut = useCallback(() => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = `${basePath}/signout`;
    form.style.display = "none";
    document.body.appendChild(form);
    form.submit();
  }, [basePath]);

  const userApi = useMemo(() => {
    const api = createUserApi((method, path, body) =>
      fetch(`${basePath}/me${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
    // A 401 means the session is over: reload it, so the page shows that.
    // After a name change the server refreshed the tokens; reload to see it.
    const wrap =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>, reloadAfter = false) =>
      async (...args: A): Promise<R> => {
        try {
          const result = await fn(...args);
          if (reloadAfter) await load();
          return result;
        } catch (err) {
          if (err instanceof UserApiError && err.status === 401) void load();
          throw err;
        }
      };
    return {
      getMe: wrap(api.getMe),
      updateMe: wrap(api.updateMe, true),
      listSessions: wrap(api.listSessions),
      endSession: wrap(api.endSession),
      listConnectedApps: wrap(api.listConnectedApps),
      revokeConnectedApp: wrap(api.revokeConnectedApp),
      listPasskeys: wrap(api.listPasskeys),
      renamePasskey: wrap(api.renamePasskey),
      removePasskey: wrap(api.removePasskey),
    } satisfies UserApi;
  }, [basePath, load]);

  const value = useMemo<AuthState>(
    () => ({
      status: session === undefined ? "loading" : session.status,
      user: session?.status === "signed-in" ? session.user : undefined,
      sessionEnded: session?.status === "signed-out" && session.ended,
      signInError,
      signIn,
      addPasskey,
      signOut,
      refresh: ({ force = false } = {}) => load(force),
      userApi,
    }),
    [session, signInError, signIn, addPasskey, signOut, load, userApi],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth must be used inside <AuthallaProvider>.");
  return auth;
}

/** Renders its children only while someone is signed in. */
export function SignedIn({ children }: { children: ReactNode }) {
  return useAuth().status === "signed-in" ? <>{children}</> : null;
}

/** Renders its children only once the session is known to be signed out. */
export function SignedOut({ children }: { children: ReactNode }) {
  return useAuth().status === "signed-out" ? <>{children}</> : null;
}
