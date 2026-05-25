import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GitHubClient,
  listCards,
  getCard,
  searchCards,
  listCategories,
  addCard,
  updateCard,
  deleteCard,
} from "./core.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: "ERROR: " + msg }], isError: true });
const run = async (fn: () => Promise<unknown>) => {
  try {
    return ok(await fn());
  } catch (e) {
    return fail((e as Error).message);
  }
};

/** Register the html-vault tools on a McpServer. Used by both stdio and Worker entrypoints. */
export function registerTools(server: McpServer, gh: GitHubClient): void {
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
    async (args) => run(() => listCards(gh, args))
  );

  server.registerTool(
    "get_card",
    {
      title: "Get card",
      description: "Get a single card by id, including its full HTML code.",
      inputSchema: { id: z.string().describe("Card id") },
    },
    async (args) => run(() => getCard(gh, args))
  );

  server.registerTool(
    "search_cards",
    {
      title: "Search cards",
      description: "Full-text search over title, description, tags and category. Returns metadata only.",
      inputSchema: { query: z.string().describe("Search text") },
    },
    async (args) => run(() => searchCards(gh, args))
  );

  server.registerTool(
    "list_categories",
    { title: "List categories", description: "List all categories with card counts.", inputSchema: {} },
    async () => run(() => listCategories(gh))
  );

  if (gh.readonly) return;

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
    async (args) => run(() => addCard(gh, args))
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
    async (args) => run(() => updateCard(gh, args))
  );

  server.registerTool(
    "delete_card",
    {
      title: "Delete card",
      description: "Delete a card by id.",
      inputSchema: { id: z.string().describe("Card id") },
    },
    async (args) => run(() => deleteCard(gh, args))
  );
}
