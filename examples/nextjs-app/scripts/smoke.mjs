// Starts the built example (`next start`) and checks what needs no Authalla
// tenant: pages render signed out, the route handler answers, and sign-in
// sends the browser to the tenant with the right parameters.
//
//   pnpm build && pnpm smoke
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 3105;
const APP = `http://localhost:${PORT}`;
const ISSUER = "https://acme.authalla.test";
const env = {
  ...process.env,
  AUTHALLA_ISSUER: ISSUER,
  AUTHALLA_CLIENT_ID: "smoke_app",
  AUTHALLA_APP_URL: APP,
  AUTHALLA_SECRET: "smoke-test-secret-smoke-test-secret-0123",
};

// Its own process group, so stopping it also stops next-server, which npx
// starts as a child: left running, it holds the pipe open and the script
// never exits.
const server = spawn("npx", ["next", "start", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "inherit"], detached: true });
let log = "";
server.stdout.on("data", (chunk) => (log += chunk));

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures.push(name);
}

try {
  for (let i = 0; ; i++) {
    try {
      await fetch(APP, { method: "HEAD" });
      break;
    } catch {
      if (i > 60) throw new Error(`next start didn't come up:\n${log}`);
      await sleep(500);
    }
  }

  const home = await fetch(`${APP}/`);
  const homeHtml = await home.text();
  check("/ renders", home.status === 200, `status ${home.status}`);
  check("/ links to sign-in from a Server Component", homeHtml.includes('href="/api/auth/signin?returnTo=%2Faccount"'));

  const session = await fetch(`${APP}/api/auth/session`);
  const body = await session.json();
  check("/api/auth/session says signed out", session.status === 200 && body.status === "signed-out", JSON.stringify(body));

  const signin = await fetch(`${APP}/api/auth/signin?returnTo=/account&prompt=login`, { redirect: "manual" });
  const location = new URL(signin.headers.get("location") ?? "", APP);
  check("/api/auth/signin redirects to the tenant", signin.status === 302 && `${location.origin}${location.pathname}` === `${ISSUER}/oauth2/authorize`, `${signin.status} ${location}`);
  check("sign-in sends the redirect URI", location.searchParams.get("redirect_uri") === `${APP}/api/auth/callback`);
  check("sign-in uses PKCE", location.searchParams.get("code_challenge_method") === "S256");
  check("sign-in passes prompt", location.searchParams.get("prompt") === "login");
  check("sign-in asks for the configured scopes", location.searchParams.get("scope")?.includes("passkeys:read"));
  check("sign-in sets the pending cookie", (signin.headers.get("set-cookie") ?? "").includes("authalla-signin="));

  // Inside <Suspense> the redirect streams to the browser rather than a 307.
  const account = await fetch(`${APP}/account`, { redirect: "manual" });
  const accountHtml = await account.text();
  check("/account sends a signed-out user to sign-in", accountHtml.includes("/api/auth/signin?returnTo=%2Faccount"), `status ${account.status}`);

  const signout = await fetch(`${APP}/api/auth/signout`, { method: "POST", headers: { Origin: "https://evil.example" }, redirect: "manual" });
  check("sign-out refuses another site", signout.status === 403, `status ${signout.status}`);
} finally {
  process.kill(-server.pid, "SIGTERM");
  server.stdout.destroy();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed. Server output:\n${log}`);
  process.exit(1);
}
console.log("\nSmoke test passed.");
