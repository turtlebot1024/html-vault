# html-vault MCP server

Lets Claude read and write your **html-vault** cards. The cards live as a single
JSON file in a (private) GitHub repo; this server talks to that file through the
GitHub Contents API. The PWA syncs the same file, so the two stay in sync.

```
[phone PWA] ⇄ [GitHub: html-vault-data/cards.json] ⇄ [MCP server] → [Claude]
```

Two ways to run the same tools (they share `src/core.ts` + `src/tools.ts`):
- **stdio** (`src/index.ts`) → for **Claude Desktop** on your PC. Simplest.
- **Cloudflare Worker** (`src/worker.ts`) → a **remote** server for **Claude on
  phone / web / desktop**, gated by GitHub login. See "Remote (phone/web)" below.

In both, the GitHub token that touches the data repo is held **server-side**
(env var or Worker secret) and is never given to Claude.

## Tools

Read:
- `list_cards` — list cards (metadata only, no HTML code). Filter by `category` / `tag`.
- `get_card` — one card by `id`, including full HTML `code`.
- `search_cards` — full-text search over title/desc/tags/category.
- `list_categories` — categories with counts.

Write (disabled when `VAULT_READONLY=true`):
- `add_card` — create a card.
- `update_card` — patch fields of a card.
- `delete_card` — remove a card.

## Setup

### 1. Create the data repo

Create a **private** repo, e.g. `your-name/html-vault-data`. It can be empty —
the first "push" from the PWA (or `add_card`) creates `cards.json` automatically.

> Keep the app repo (`html-vault`, public, GitHub Pages) separate from this data
> repo (private). No secrets ever live in the public app code.

### 2. Create a GitHub token

Fine-grained PAT (recommended), scoped to the data repo only:
- **Repository access** → Only select repositories → `html-vault-data`
- **Permissions** → Repository permissions → **Contents: Read and write**

(A classic PAT with the `repo` scope also works but grants far more.)

### 3. Build

```bash
cd mcp-server
npm install
npm run build
```

### 4. Register in Claude Desktop

Edit `claude_desktop_config.json`:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "html-vault": {
      "command": "node",
      "args": ["/absolute/path/to/html-vault/mcp-server/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "github_pat_...",
        "VAULT_REPO": "your-name/html-vault-data",
        "VAULT_PATH": "cards.json",
        "VAULT_BRANCH": "main",
        "VAULT_READONLY": "false"
      }
    }
  }
}
```

Restart Claude Desktop. You should see the `html-vault` tools available.

## Remote (phone / web) — Cloudflare Worker + GitHub OAuth

This deploys the same tools as a public HTTPS endpoint that Claude on **phone,
web, or desktop** can connect to. Only your GitHub account may connect (OAuth
login gate); the repo is accessed with the server-side `GITHUB_TOKEN` secret.

```
[Claude phone/web] --GitHub OAuth--> [Cloudflare Worker /mcp] --GITHUB_TOKEN--> [html-vault-data]
```

### A. One-time Cloudflare + GitHub OAuth setup

1. Install deps and log in to Cloudflare:
   ```bash
   cd mcp-server
   npm install
   npx wrangler login
   ```
2. Create the KV namespace used by the OAuth provider, then paste the printed id
   into `wrangler.jsonc` → `kv_namespaces[0].id` (replacing `REPLACE_WITH_KV_NAMESPACE_ID`):
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```
3. Edit `wrangler.jsonc` → `vars`: set `VAULT_REPO` and `ALLOWED_GITHUB_LOGIN`
   (your GitHub username; comma-separate to allow more than one).
4. Create a **GitHub OAuth App** (GitHub → Settings → Developer settings → OAuth Apps
   → New). You will fill the two URLs after the first deploy gives you the Worker URL,
   so for now use a placeholder and update in step 6.
   - Authorization callback URL: `https://<worker-url>/callback`
5. Set the secrets (prompts for each value; never commit these):
   ```bash
   npx wrangler secret put GITHUB_TOKEN          # fine-grained PAT, Contents R/W on data repo
   npx wrangler secret put GITHUB_CLIENT_ID       # from the GitHub OAuth App
   npx wrangler secret put GITHUB_CLIENT_SECRET   # from the GitHub OAuth App
   ```
6. Deploy, then put the real Worker URL into the GitHub OAuth App's Homepage URL
   (`https://<worker-url>`) and callback URL (`https://<worker-url>/callback`):
   ```bash
   npm run deploy
   ```
   The MCP endpoint is `https://<name>.<your-subdomain>.workers.dev/mcp`.

### B. Add the connector in Claude (phone / web)

Claude → **Settings → Connectors → Add custom connector** → paste the `/mcp` URL →
**Add** → click **Connect** and complete the GitHub login. (Custom connectors work on
Free/Pro/Max; Free allows one.) After connecting, ask Claude things like "list my
html-vault categories" or "save this HTML as a card in 업무".

### Local development

```bash
# put real values in mcp-server/.dev.vars (gitignored):
#   GITHUB_TOKEN="..."
#   GITHUB_CLIENT_ID="..."
#   GITHUB_CLIENT_SECRET="..."
npm run cf-dev          # http://localhost:8787 ; /mcp is OAuth-gated (401 without a token)
npm run typecheck:worker
```

## Environment variables

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `GITHUB_TOKEN` | yes | — | PAT with Contents read/write on the data repo |
| `VAULT_REPO` | yes | — | `owner/repo` of the data repo |
| `VAULT_PATH` | no | `cards.json` | path to the JSON file in the repo |
| `VAULT_BRANCH` | no | `main` | branch |
| `VAULT_READONLY` | no | `false` | `true` hides the write tools |

Worker-only (set as secrets / `vars`, not used by stdio):

| Var | Required | Meaning |
|-----|----------|---------|
| `GITHUB_CLIENT_ID` | yes | GitHub OAuth App client id (login gate) |
| `GITHUB_CLIENT_SECRET` | yes | GitHub OAuth App client secret |
| `ALLOWED_GITHUB_LOGIN` | no | comma-separated GitHub usernames allowed to connect; empty = any |

## Data format

`cards.json` is an envelope the PWA also understands:

```json
{
  "app": "html-vault",
  "updatedAt": 1716600000000,
  "count": 2,
  "items": [
    { "id": "c_...", "category": "업무", "title": "...", "desc": "...",
      "tags": ["..."], "ref": "https://...", "code": "<!DOCTYPE html>...",
      "pinned": false, "created": 1716000000000 }
  ]
}
```

A bare JSON array of cards is also accepted on read, for backward compatibility.

## Notes

- Every write is a separate commit to the data repo, so its git history is your
  audit log / backup.
- stdio (Desktop) and the Worker (phone/web) expose the **same tools** and share
  the **same** `cards.json`, so you can use either or both.
- Sync is last-write-wins. If you edit on the phone and via Claude at the same
  time, push/pull deliberately rather than relying on automatic merging.
