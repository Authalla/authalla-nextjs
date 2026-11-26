// The User API (/me/v1): what a signed-in user can see and change about
// their own account. One typed surface for both sides: on the server it
// calls Authalla with the session's access token, in the browser it goes
// through the SDK's route handler, which adds the token there.

/** The signed-in user. */
export type Me = {
  id: string;
  name: string;
  /** Present when the token has the email scope. */
  email?: string;
  email_verified?: boolean;
  updated_at: string;
};

/** A browser the user is signed in on. */
export type UserSession = {
  id: string;
  /** How the user signed in, e.g. passkey, magic_link, pin_code, social-login-google. */
  auth_method: string;
  ip_address: string;
  user_agent: string;
  created_at: string;
  expires_at: string;
  /** This app's session came from this browser session. */
  current: boolean;
};

/** An app holding a remembered consent or a live refresh token for the user. */
export type ConnectedApp = {
  id: string;
  client_id: string;
  name: string;
  /** Registered itself (Claude, ChatGPT…) rather than added by the tenant's admin. */
  self_registered: boolean;
  resource_servers: { identifier: string; name?: string }[];
  scopes: string[];
  last_used_at?: string;
  /** This is the app calling. */
  current: boolean;
};

export type ConnectedApps = {
  connected_apps: ConnectedApp[];
  /** After a revoke, an API that checks tokens locally accepts the app's last one for at most this long. */
  access_token_lifetime_seconds: number;
};

/** A passkey the user signs in with. */
export type Passkey = {
  id: string;
  /** The name the user gave it; absent until they name it. */
  name?: string;
  /** Where it's kept, e.g. "iCloud Keychain", when it identifies itself and Authalla knows it. */
  authenticator?: string;
  created_at: string;
  /** When it last signed the user in; absent if it never has. */
  last_used_at?: string;
};

/**
 * A User API call that failed. status 0 means it never got an answer.
 * 401 means the session is over; 403 means the session's token lacks the
 * scope, which signing in again (with the scope configured) fixes.
 */
export class UserApiError extends Error {
  name = "AuthallaUserApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type UserApiTransport = (method: string, path: string, body?: unknown) => Promise<Response>;

export type UserApi = ReturnType<typeof createUserApi>;

export function createUserApi(transport: UserApiTransport) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await transport(method, path, body);
    } catch (err) {
      throw new UserApiError(0, "unreachable", `Authalla didn't answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (response.status === 204) return undefined as T;
    const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!response.ok) {
      const code = typeof payload?.error === "string" ? payload.error : `http_${response.status}`;
      const message = typeof payload?.message === "string" ? payload.message : `The User API answered ${response.status}`;
      throw new UserApiError(response.status, code, message);
    }
    return payload as T;
  }

  return {
    /** Needs the profile scope; email and email_verified need email too. */
    getMe: () => call<Me>("GET", ""),
    /** Needs the profile scope. The session's ID token is refreshed to carry the new name. */
    updateMe: (changes: { name: string }) => call<Me>("PATCH", "", changes),
    /** Needs sessions:read. */
    listSessions: () => call<{ sessions: UserSession[] }>("GET", "/sessions").then((r) => r.sessions),
    /** Signs that browser out. Needs sessions:write. */
    endSession: (id: string) => call<void>("DELETE", `/sessions/${encodeURIComponent(id)}`),
    /** Needs connected-apps:read. */
    listConnectedApps: () => call<ConnectedApps>("GET", "/connected-apps"),
    /** Revokes the app's tokens and consent. Needs connected-apps:write. */
    revokeConnectedApp: (id: string) => call<void>("DELETE", `/connected-apps/${encodeURIComponent(id)}`),
    /** Needs passkeys:read. */
    listPasskeys: () => call<{ passkeys: Passkey[] }>("GET", "/passkeys").then((r) => r.passkeys),
    /** Needs passkeys:write. */
    renamePasskey: (id: string, name: string) => call<Passkey>("PATCH", `/passkeys/${encodeURIComponent(id)}`, { name }),
    /** It stops signing the user in. Needs passkeys:write. */
    removePasskey: (id: string) => call<void>("DELETE", `/passkeys/${encodeURIComponent(id)}`),
  };
}
