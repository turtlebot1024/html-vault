# html-vault MCP server

Lets Claude read and write your **html-vault** cards. The cards live as a single
JSON file in a (private) GitHub repo; this server talks to that file through the
GitHub Contents API. The PWA syncs the same file, so the two stay in sync.

```
[phone PWA] ⇄ [GitHub: html-vault-data/cards.json] ⇄ [this MCP server] → [Claude]
```

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

## Environment variables

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `GITHUB_TOKEN` | yes | — | PAT with Contents read/write on the data repo |
| `VAULT_REPO` | yes | — | `owner/repo` of the data repo |
| `VAULT_PATH` | no | `cards.json` | path to the JSON file in the repo |
| `VAULT_BRANCH` | no | `main` | branch |
| `VAULT_READONLY` | no | `false` | `true` hides the write tools |

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
- This is a local **stdio** server (Claude Desktop). A remote (HTTP/SSE) variant
  for Claude web/mobile can be layered on top of the same GitHub backend later.
- Sync is last-write-wins. If you edit on the phone and via Claude at the same
  time, push/pull deliberately rather than relying on automatic merging.
