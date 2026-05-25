/* Runtime-agnostic core: card types, GitHub client, and tool operations.
   Used by both the stdio entrypoint (Node) and the Cloudflare Worker. */

export interface Card {
  id: string;
  category?: string;
  title?: string;
  desc?: string;
  tags?: string[];
  ref?: string;
  code?: string;
  pinned?: boolean;
  created?: number;
}

export const ETC = "기타";
export const catOf = (c: Card): string => (c.category && c.category.trim()) || ETC;
export const newId = (): string => "c_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);

/* ---------- cross-runtime base64 (Node 18+ and Workers, UTF-8 safe) ---------- */
export function encodeBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
export function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ---------- GitHub Contents API client ---------- */
export interface GitHubConfig {
  token: string;
  repo: string; // "owner/repo"
  path: string;
  branch: string;
  readonly: boolean;
}

export function configFromEnv(env: Record<string, string | undefined>): GitHubConfig {
  const token = env.GITHUB_TOKEN ?? "";
  const repo = env.VAULT_REPO ?? "";
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!repo || !repo.includes("/")) throw new Error('VAULT_REPO must be "owner/repo"');
  return {
    token,
    repo,
    path: env.VAULT_PATH ?? "cards.json",
    branch: env.VAULT_BRANCH ?? "main",
    readonly: env.VAULT_READONLY === "true",
  };
}

export class GitHubClient {
  constructor(private cfg: GitHubConfig) {}

  get readonly(): boolean {
    return this.cfg.readonly;
  }

  private url(): string {
    const [owner, repo] = this.cfg.repo.split("/");
    const p = this.cfg.path.split("/").map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${owner}/${repo}/contents/${p}`;
  }
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "html-vault-mcp",
    };
  }

  async getFile(): Promise<{ sha: string | null; items: Card[] }> {
    const res = await fetch(`${this.url()}?ref=${encodeURIComponent(this.cfg.branch)}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return { sha: null, items: [] };
    if (!res.ok) throw new Error(`GitHub GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { sha: string; content: string };
    const data = JSON.parse(decodeBase64(j.content));
    const items: Card[] = Array.isArray(data) ? data : data.items ?? [];
    return { sha: j.sha, items };
  }

  async putFile(items: Card[], sha: string | null, message: string): Promise<void> {
    if (this.cfg.readonly) {
      throw new Error("Server is read-only (VAULT_READONLY=true). Write operations are disabled.");
    }
    const envelope = { app: "html-vault", source: "mcp", updatedAt: Date.now(), count: items.length, items };
    const body: Record<string, unknown> = {
      message,
      content: encodeBase64(JSON.stringify(envelope, null, 2)),
      branch: this.cfg.branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(this.url(), { method: "PUT", headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`GitHub PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/* ---------- presentation helpers ---------- */
export function lite(c: Card) {
  return {
    id: c.id,
    category: catOf(c),
    title: c.title ?? "",
    desc: c.desc ?? "",
    tags: c.tags ?? [],
    ref: c.ref ?? "",
    pinned: !!c.pinned,
    hasCode: !!(c.code && c.code.length),
    created: c.created ? new Date(c.created).toISOString() : null,
  };
}

/* ---------- tool operations (pure-ish: take a client, return plain data) ---------- */
export async function listCards(gh: GitHubClient, args: { category?: string; tag?: string; limit?: number }) {
  const { items } = await gh.getFile();
  let list = items;
  if (args.category) list = list.filter((c) => catOf(c) === args.category);
  if (args.tag) list = list.filter((c) => (c.tags ?? []).includes(args.tag!));
  list = list.slice().sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  if (args.limit) list = list.slice(0, args.limit);
  return { total: items.length, returned: list.length, cards: list.map(lite) };
}

export async function getCard(gh: GitHubClient, args: { id: string }) {
  const { items } = await gh.getFile();
  const card = items.find((c) => c.id === args.id);
  if (!card) throw new Error(`Card not found: ${args.id}`);
  return { ...card, category: catOf(card) };
}

export async function searchCards(gh: GitHubClient, args: { query: string }) {
  const { items } = await gh.getFile();
  const q = args.query.toLowerCase();
  const hits = items.filter(
    (c) =>
      (c.title ?? "").toLowerCase().includes(q) ||
      (c.desc ?? "").toLowerCase().includes(q) ||
      catOf(c).toLowerCase().includes(q) ||
      (c.tags ?? []).join(" ").toLowerCase().includes(q)
  );
  return { query: args.query, returned: hits.length, cards: hits.map(lite) };
}

export async function listCategories(gh: GitHubClient) {
  const { items } = await gh.getFile();
  const counts = new Map<string, number>();
  for (const c of items) counts.set(catOf(c), (counts.get(catOf(c)) ?? 0) + 1);
  const categories = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
  return { total: items.length, categories };
}

export interface CardInput {
  title: string;
  desc?: string;
  category?: string;
  tags?: string[];
  ref?: string;
  code?: string;
}

export async function addCard(gh: GitHubClient, args: CardInput) {
  const { items, sha } = await gh.getFile();
  const card: Card = {
    id: newId(),
    title: args.title,
    desc: args.desc ?? "",
    category: args.category ?? "",
    tags: args.tags ?? [],
    ref: args.ref ?? "",
    code: args.code ?? "",
    pinned: false,
    created: Date.now(),
  };
  items.push(card);
  await gh.putFile(items, sha, `mcp: add card "${args.title}"`);
  return { added: card.id, card: lite(card) };
}

export async function updateCard(
  gh: GitHubClient,
  args: { id: string } & Partial<CardInput> & { pinned?: boolean }
) {
  const { items, sha } = await gh.getFile();
  const card = items.find((c) => c.id === args.id);
  if (!card) throw new Error(`Card not found: ${args.id}`);
  const target = card as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(args)) {
    if (k !== "id" && v !== undefined) target[k] = v;
  }
  await gh.putFile(items, sha, `mcp: update card ${args.id}`);
  return { updated: args.id, card: lite(card) };
}

export async function deleteCard(gh: GitHubClient, args: { id: string }) {
  const { items, sha } = await gh.getFile();
  const idx = items.findIndex((c) => c.id === args.id);
  if (idx === -1) throw new Error(`Card not found: ${args.id}`);
  const [removed] = items.splice(idx, 1);
  await gh.putFile(items, sha, `mcp: delete card ${args.id}`);
  return { deleted: args.id, title: removed.title ?? "" };
}
