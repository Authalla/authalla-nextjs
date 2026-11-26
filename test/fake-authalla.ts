// A stand-in for an Authalla tenant, answering the SDK's fetch calls the way
// the real endpoints do, plus a cookie-keeping browser to drive the route
// handler with.

import { createHash } from "node:crypto";
import { vi } from "vitest";

export const ISSUER = "https://acme.authalla.test";
export const APP = "https://app.example.test";
export const CLIENT_ID = "app_123";

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function jwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.c2lnbmF0dXJl`;
}

type Grant = { refreshToken: string; revoked: boolean };

// Refresh tokens are unique across the whole run, as real ones are: the SDK
// shares a refresh between requests by token, process-wide.
let issued = 0;

export class FakeAuthalla {
  user = { sub: "usr_1", name: "Jane Doe", email: "jane@example.com", picture: "https://images.example.com/jane.png" };
  calls: { url: URL; method: string; headers: Headers; body: string }[] = [];
  expiresIn = 3600;
  /** Override the next token response's nonce, to test a mismatch. */
  nonceOverride: string | undefined;
  /** Make the token endpoint unreachable. */
  down = false;
  extraClaims: Record<string, unknown> = {};
  private codes = new Map<string, { challenge: string; nonce: string; redirectUri: string }>();
  private grants: Grant[] = [];

  install() {
    vi.stubGlobal("fetch", (input: string | URL, init: RequestInit = {}) => this.fetch(new URL(String(input)), init));
  }

  /** What the authorization endpoint would do once the user signs in. */
  approve(authorizeUrl: string): { code: string; state: string } {
    const url = new URL(authorizeUrl);
    const code = `code_${this.codes.size + 1}`;
    this.codes.set(code, {
      challenge: url.searchParams.get("code_challenge")!,
      nonce: url.searchParams.get("nonce")!,
      redirectUri: url.searchParams.get("redirect_uri")!,
    });
    return { code, state: url.searchParams.get("state")! };
  }

  get refreshTokens() {
    return this.grants.map((g) => g.refreshToken);
  }

  revokeAll() {
    for (const grant of this.grants) grant.revoked = true;
  }

  tokenCalls(grantType: string) {
    return this.calls.filter((c) => c.url.pathname === "/oauth2/token" && new URLSearchParams(c.body).get("grant_type") === grantType);
  }

  private tokens(nonce?: string, grant?: Grant) {
    issued++;
    const refreshToken = `rt_${issued}`;
    if (grant) grant.refreshToken = refreshToken;
    else this.grants.push({ refreshToken, revoked: false });
    const idClaims: Record<string, unknown> = {
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: this.user.sub,
      name: this.user.name,
      email: this.user.email,
      email_verified: true,
      picture: this.user.picture,
      ...this.extraClaims,
    };
    if (nonce !== undefined) idClaims.nonce = this.nonceOverride ?? nonce;
    return Response.json({
      access_token: jwt({ iss: ISSUER, sub: this.user.sub, n: issued }),
      token_type: "Bearer",
      expires_in: this.expiresIn,
      refresh_token: refreshToken,
      id_token: jwt(idClaims),
      scope: "openid profile email offline_access",
    });
  }

  private async fetch(url: URL, init: RequestInit): Promise<Response> {
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "";
    const headers = new Headers(init.headers);
    this.calls.push({ url, method: init.method ?? "GET", headers, body });
    if (url.origin !== ISSUER) throw new TypeError("fetch failed");
    if (this.down) throw new TypeError("fetch failed");
    const form = new URLSearchParams(body);

    if (url.pathname === "/oauth2/token" && form.get("grant_type") === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? "");
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (!code || code.challenge !== challenge || code.redirectUri !== form.get("redirect_uri")) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return this.tokens(code.nonce);
    }
    if (url.pathname === "/oauth2/token" && form.get("grant_type") === "refresh_token") {
      // A tick, so concurrent refreshes really overlap.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const grant = this.grants.find((g) => g.refreshToken === form.get("refresh_token"));
      if (!grant || grant.revoked) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return this.tokens(undefined, grant);
    }
    if (url.pathname === "/oauth2/revoke") {
      const grant = this.grants.find((g) => g.refreshToken === form.get("token"));
      if (grant) grant.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/me/v1") {
      if (!headers.get("Authorization")?.startsWith("Bearer ")) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (init.method === "PATCH") this.user.name = JSON.parse(body).name;
      return Response.json({ id: this.user.sub, name: this.user.name, email: this.user.email, updated_at: "2026-11-24T10:00:00Z" });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

/** Keeps cookies the way a browser does, for one origin. */
export class Browser {
  cookies = new Map<string, string>();

  constructor(private readonly handle: (request: Request) => Promise<Response>) {}

  async request(path: string, init: RequestInit & { crossSite?: boolean } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.method && init.method !== "GET") headers.set("Origin", init.crossSite ? "https://evil.example" : APP);
    const response = await this.handle(new Request(`${APP}${path}`, { ...init, headers }));
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split("; ");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      if (attributes.includes("Max-Age=0")) this.cookies.delete(name);
      else this.cookies.set(name, pair.slice(eq + 1));
    }
    return response;
  }

  async session() {
    return (await this.request("/api/auth/session")).json();
  }
}
