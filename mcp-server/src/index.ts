#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/* ---------- config ---------- */
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const REPO = process.env.VAULT_REPO ?? ""; // "owner/repo"
const PATH = process.env.VAULT_PATH ?? "cards.json";
const BRANCH = process.env.VAULT_BRANCH ?? "main";
const READONLY = process.env.VAULT_READONLY === "true";

if (!TOKEN) throw new Error("GITHUB_TOKEN env var is required");
if (!REPO || !REPO.includes("/")) throw new Error('VAULT_REPO env var must be "owner/repo"');

const [OWNER, REPO_NAME] = REPO.split("/");

/* ---------- types ---------- */
interface Card {
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

const ETC = "기타";
const catOf = (c: Card) => (c.category && c.category.trim()) || ETC;

/* ---------- GitHub Contents API ---------- */
const apiUrl = () =>
  `https://api.github.com/repos/${OWNER}/${REPO_NAME}/contents/${PATH.split("/").map(encodeURIComponent).join("/")}`;

const ghHeaders = () => ({
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "html-vault-mcp",
});

async function getFile(): Promise<{ sha: string | null; items: Card[] }> {
  const res = await fetch(`${apiUrl()}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders() });
  if (res.status === 404) return { sha: null, items: [] };
  if (!res.ok) throw new Error(`GitHub GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { sha: string; content: string };
  const text = Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf-8");
  const data = JSON.parse(text);
  const items: Card[] = Array.isArray(data) ? data : data.items ?? [];
  return { sha: j.sha, items };
}

async function putFile(items: Card[], sha: string | null, message: string): Promise<void> {
  if (READONLY) throw new Error("Server is read-only (VAULT_READONLY=true). Write operations are disabled.");
  const envelope = { app: "html-vault", source: "mcp", updatedAt: Date.now(), count: items.length, items };
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(JSON.stringify(envelope, null, 2), "utf-8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(apiUrl(), { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const newId = () => "c_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);

// strip heavy `code` field for list/search output to save tokens
function lite(c: Card) {
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

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: "ERROR: " + msg }], isError: true });

/* ---------- server ---------- */
const server = new McpServer({ name: "html-vault", version: "1.0.0" });

server.registerTool(
  "list_cards",
  {
    title: "List cards",
    description:
      "List stored cards (metadata only, without HTML code). Optionally filter by category and/or tag. Use get_card to fetch full HTML code of one card.",
    inputSchema: {
      category: z.string().optional().describe("Filter by category (e.g. 업무, 투자)"),
      tag: z.string().optional().describe("Filter by tag"),
      limit: z.number().int().positive().max(500).optional().describe("Max number of cards to return"),
    },
  },
  async ({ category, tag, limit }) => {
    try {
      const { items } = await getFile();
      let list = items;
      if (category) list = list.filter((c) => catOf(c) === category);
      if (tag) list = list.filter((c) => (c.tags ?? []).includes(tag));
      list = list.slice().sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
      if (limit) list = list.slice(0, limit);
      return ok({ total: items.length, returned: list.length, cards: list.map(lite) });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.registerTool(
  "get_card",
  {
    title: "Get card",
    description: "Get a single card by id, including its full HTML code.",
    inputSchema: { id: z.string().describe("Card id") },
  },
  async ({ id }) => {
    try {
      const { items } = await getFile();
      const card = items.find((c) => c.id === id);
      if (!card) return fail(`Card not found: ${id}`);
      return ok({ ...card, category: catOf(card) });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.registerTool(
  "search_cards",
  {
    title: "Search cards",
    description: "Full-text search over title, description, tags and category. Returns metadata only.",
    inputSchema: { query: z.string().describe("Search text") },
  },
  async ({ query }) => {
    try {
      const { items } = await getFile();
      const q = query.toLowerCase();
      const hits = items.filter(
        (c) =>
          (c.title ?? "").toLowerCase().includes(q) ||
          (c.desc ?? "").toLowerCase().includes(q) ||
          catOf(c).toLowerCase().includes(q) ||
          (c.tags ?? []).join(" ").toLowerCase().includes(q)
      );
      return ok({ query, returned: hits.length, cards: hits.map(lite) });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.registerTool(
  "list_categories",
  {
    title: "List categories",
    description: "List all categories with card counts.",
    inputSchema: {},
  },
  async () => {
    try {
      const { items } = await getFile();
      const counts = new Map<string, number>();
      for (const c of items) counts.set(catOf(c), (counts.get(catOf(c)) ?? 0) + 1);
      const cats = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, count]) => ({ name, count }));
      return ok({ total: items.length, categories: cats });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

if (!READONLY) {
  server.registerTool(
    "add_card",
    {
      title: "Add card",
      description: "Create a new card and commit it to the GitHub repo.",
      inputSchema: {
        title: z.string().describe("Card title (required)"),
        desc: z.string().optional().describe("Description / memo"),
        category: z.string().optional().describe("Category (1st-level grouping). Defaults to 기타 if empty."),
        tags: z.array(z.string()).optional().describe("Tags (2nd-level labels)"),
        ref: z.string().optional().describe("Reference link (e.g. claude.ai chat URL)"),
        code: z.string().optional().describe("HTML source code of the artifact"),
      },
    },
    async ({ title, desc, category, tags, ref, code }) => {
      try {
        const { items, sha } = await getFile();
        const card: Card = {
          id: newId(),
          title,
          desc: desc ?? "",
          category: category ?? "",
          tags: tags ?? [],
          ref: ref ?? "",
          code: code ?? "",
          pinned: false,
          created: Date.now(),
        };
        items.push(card);
        await putFile(items, sha, `mcp: add card "${title}"`);
        return ok({ added: card.id, card: lite(card) });
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );

  server.registerTool(
    "update_card",
    {
      title: "Update card",
      description: "Update fields of an existing card. Only provided fields are changed.",
      inputSchema: {
        id: z.string().describe("Card id"),
        title: z.string().optional(),
        desc: z.string().optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
        ref: z.string().optional(),
        code: z.string().optional(),
        pinned: z.boolean().optional(),
      },
    },
    async ({ id, ...fields }) => {
      try {
        const { items, sha } = await getFile();
        const card = items.find((c) => c.id === id);
        if (!card) return fail(`Card not found: ${id}`);
        const target = card as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(fields)) {
          if (v !== undefined) target[k] = v;
        }
        await putFile(items, sha, `mcp: update card ${id}`);
        return ok({ updated: id, card: lite(card) });
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );

  server.registerTool(
    "delete_card",
    {
      title: "Delete card",
      description: "Delete a card by id.",
      inputSchema: { id: z.string().describe("Card id") },
    },
    async ({ id }) => {
      try {
        const { items, sha } = await getFile();
        const idx = items.findIndex((c) => c.id === id);
        if (idx === -1) return fail(`Card not found: ${id}`);
        const [removed] = items.splice(idx, 1);
        await putFile(items, sha, `mcp: delete card ${id}`);
        return ok({ deleted: id, title: removed.title ?? "" });
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );
}

/* ---------- run ---------- */
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `html-vault MCP server running (repo=${REPO}, path=${PATH}, branch=${BRANCH}, readonly=${READONLY})`
);
