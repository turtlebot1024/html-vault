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
  phone / web / desktop**. See "Remote (phone/web)" below.

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

## Remote (phone / web) — Cloudflare Worker, deployed from your phone

The same tools, as a public HTTPS endpoint that Claude on **phone / web / desktop**
can connect to. This setup is **authless**: access control is the unguessable
`workers.dev` URL, and the repo is reached with the server-side `GITHUB_TOKEN`
secret (never sent to Claude).

```
[Claude phone/web] --> [Cloudflare Worker /mcp] --GITHUB_TOKEN(secret)--> [html-vault-data]
```

> Authless = anyone who knows the exact Worker URL could read/write your cards.
> Fine for a personal vault with a random URL. To add a GitHub-login gate later,
> wrap the handlers in `@cloudflare/workers-oauth-provider` (see git history).

### Deploy with no computer — GitHub Actions

A workflow at `.github/workflows/deploy-mcp-worker.yml` runs `wrangler deploy` in CI,
so you can do everything from the **GitHub app / website + Cloudflare dashboard** on
your phone.

1. **Cloudflare** (dashboard.cloudflare.com on mobile): sign up (free). Copy your
   **Account ID** (Workers & Pages → right sidebar). Create an **API token**
   (My Profile → API Tokens → Create Token → template *Edit Cloudflare Workers*).
2. **GitHub** → this repo → **Settings → Secrets and variables → Actions → New repository secret**.
   Add three secrets:
   - `CLOUDFLARE_API_TOKEN` — the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID` — the account id from step 1
   - `VAULT_GITHUB_PAT` — a fine-grained GitHub PAT, *Only* `html-vault-data`,
     **Contents: Read and write** (named `VAULT_GITHUB_PAT` because `GITHUB_TOKEN`
     is a reserved Actions name)
3. **GitHub** → **Actions** tab → **Deploy MCP Worker** → **Run workflow**.
   When it finishes, open the *Deploy worker* step log and copy the published URL —
   your endpoint is `https://html-vault-mcp.<your-subdomain>.workers.dev/mcp`.

(If you do have a computer, the same thing is just `cd mcp-server && npm install &&
npx wrangler login && npx wrangler secret put GITHUB_TOKEN && npm run deploy`.)

### Add the connector in Claude (phone / web)

Claude → **Settings → Connectors → Add custom connector** → paste the `/mcp` URL →
**Add**. (Custom connectors work on Free/Pro/Max; Free allows one.) Then ask Claude
things like "list my html-vault categories" or "save this HTML as a card in 업무".

### Local development (optional, needs a computer)

```bash
echo 'GITHUB_TOKEN="<pat>"' > mcp-server/.dev.vars   # gitignored
npm run cf-dev          # http://localhost:8787/mcp  (authless)
npm run typecheck:worker
```

## Environment variables

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `GITHUB_TOKEN` | yes | — | PAT/secret with Contents read/write on the data repo |
| `VAULT_REPO` | yes | — | `owner/repo` of the data repo |
| `VAULT_PATH` | no | `cards.json` | path to the JSON file in the repo |
| `VAULT_BRANCH` | no | `main` | branch |
| `VAULT_READONLY` | no | `false` | `true` hides the write tools |

For the Worker, `VAULT_*` live in `wrangler.jsonc` → `vars`; `GITHUB_TOKEN` is a
secret (set by the deploy workflow or `wrangler secret put`).

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
