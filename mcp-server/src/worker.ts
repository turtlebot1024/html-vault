import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import OAuthProvider, { type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { GitHubClient, configFromEnv } from "./core.js";
import { registerTools } from "./tools.js";

export interface Env {
  // repo access (server-side secret + config)
  GITHUB_TOKEN: string;
  VAULT_REPO: string;
  VAULT_PATH?: string;
  VAULT_BRANCH?: string;
  VAULT_READONLY?: string;
  // GitHub OAuth (login gate)
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_LOGIN?: string; // comma-separated allowlist; empty = allow any GitHub user
  // bindings
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
}

type Props = { login: string };

/* ---------- MCP agent (Durable Object) ---------- */
export class HtmlVaultMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "html-vault", version: "1.1.0" });

  async init(): Promise<void> {
    const cfg = configFromEnv(this.env as unknown as Record<string, string | undefined>);
    registerTools(this.server, new GitHubClient(cfg));
  }
}

/* ---------- base64url for carrying the auth request through GitHub ---------- */
const b64urlEncode = (s: string): string =>
  btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s: string): string =>
  decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

const callbackUrl = (origin: string) => new URL("/callback", origin).href;

/* ---------- GitHub OAuth handler (login gate; not used for repo access) ---------- */
const githubHandler = {
  async fetch(request: Request, rawEnv: unknown): Promise<Response> {
    const env = rawEnv as Env;
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const gh = new URL("https://github.com/login/oauth/authorize");
      gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      gh.searchParams.set("redirect_uri", callbackUrl(url.origin));
      gh.searchParams.set("scope", "read:user");
      gh.searchParams.set("state", b64urlEncode(JSON.stringify(authReq)));
      return Response.redirect(gh.href, 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return new Response("Missing code/state", { status: 400 });
      let authReq: AuthRequest;
      try {
        authReq = JSON.parse(b64urlDecode(state));
      } catch {
        return new Response("Bad state", { status: 400 });
      }

      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: callbackUrl(url.origin),
        }),
      });
      const tok = (await tokenRes.json()) as { access_token?: string };
      if (!tok.access_token) return new Response("OAuth token exchange failed", { status: 401 });

      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${tok.access_token}`,
          "User-Agent": "html-vault-mcp",
          Accept: "application/vnd.github+json",
        },
      });
      const user = (await userRes.json()) as { login?: string };
      const allow = (env.ALLOWED_GITHUB_LOGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!user.login || (allow.length > 0 && !allow.includes(user.login))) {
        return new Response(`Access denied for GitHub user: ${user.login ?? "unknown"}`, { status: 403 });
      }

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: authReq,
        userId: user.login,
        metadata: { login: user.login },
        scope: authReq.scope ?? [],
        props: { login: user.login } satisfies Props,
      });
      return Response.redirect(redirectTo, 302);
    }

    return new Response("Not found", { status: 404 });
  },
};

/* ---------- OAuth-wrapped MCP endpoints ---------- */
export default new OAuthProvider({
  apiHandlers: {
    "/mcp": HtmlVaultMCP.serve("/mcp"),
    "/sse": HtmlVaultMCP.serveSSE("/sse"),
  },
  defaultHandler: githubHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
