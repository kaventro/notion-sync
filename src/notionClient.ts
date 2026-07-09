import { activeWindow, requestUrl } from "obsidian";
import { RateLimiter } from "./rateLimiter";
import type { NotionBlock, NotionApiBlock } from "./types";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const BLOCKS_PER_BATCH = 100;

interface NotionErrorBody {
  message?: string;
  code?: string;
}

interface NotionApiError extends Error {
  status: number;
  code?: string;
}

/**
 * Wrapper around the Notion REST API using Obsidian's requestUrl.
 * Avoids the @notionhq/client SDK to prevent Electron/CORS issues.
 */
export class NotionClient {
  private token: string;
  private limiter: RateLimiter;

  constructor(token: string) {
    this.token = token;
    this.limiter = new RateLimiter(3);
  }

  updateToken(token: string): void {
    this.token = token;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Record<string, unknown>> {
    return this.limiter.schedule(async () => {
      const resp = await requestUrl({
        url: `${NOTION_API}${path}`,
        method,
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        throw: false,
      });

      if (resp.status === 429) {
        const retryAfter = resp.headers["retry-after"] || "1";
        const waitMs = parseFloat(retryAfter) * 1000;
        await new Promise((r) => activeWindow.setTimeout(r, waitMs));
        return this.request(method, path, body);
      }

      let json: Record<string, unknown>;
      try {
        json = resp.json as Record<string, unknown>;
      } catch {
        throw new Error(`Notion API error ${resp.status}: ${resp.text}`);
      }

      if (resp.status < 200 || resp.status >= 300) {
        const errBody = json as NotionErrorBody;
        const msg = errBody?.message || resp.text || `HTTP ${resp.status}`;
        const err = new Error(`Notion API error: ${msg}`) as NotionApiError;
        err.status = resp.status;
        err.code = errBody?.code;
        throw err;
      }

      return json;
    });
  }

  /** Create a page under a parent page */
  async createPage(
    parentPageId: string,
    title: string,
    children: NotionBlock[] = [],
    properties?: Record<string, unknown>,
    icon?: string
  ): Promise<string> {
    const inlineChildren = children.slice(0, BLOCKS_PER_BATCH);
    const remainingChildren = children.slice(BLOCKS_PER_BATCH);

    const body: Record<string, unknown> = {
      parent: { type: "page_id", page_id: parentPageId },
      properties: {
        title: { title: [{ type: "text", text: { content: title } }] },
        ...properties,
      },
      children: inlineChildren,
    };

    if (icon) {
      body.icon = { type: "emoji", emoji: icon };
    }

    const response = await this.request("POST", "/pages", body);
    const pageId = response.id as string;

    if (remainingChildren.length > 0) {
      await this.appendBlocks(pageId, remainingChildren);
    }

    return pageId;
  }

  /** Append blocks to a page in batches of 100 */
  async appendBlocks(pageId: string, blocks: NotionBlock[]): Promise<void> {
    for (let i = 0; i < blocks.length; i += BLOCKS_PER_BATCH) {
      const batch = blocks.slice(i, i + BLOCKS_PER_BATCH);
      await this.request("PATCH", `/blocks/${pageId}/children`, {
        children: batch,
      });
    }
  }

  /** Delete all child blocks of a page */
  async clearPageContent(pageId: string): Promise<void> {
    const children = await this.listAllBlocks(pageId);
    for (const block of children) {
      await this.request("DELETE", `/blocks/${block.id}`);
    }
  }

  /** List all child blocks (handles pagination) — returns id+type only */
  async listAllBlocks(
    pageId: string
  ): Promise<Array<{ id: string; type: string }>> {
    const blocks: Array<{ id: string; type: string }> = [];
    let cursor: string | undefined;

    do {
      const params = cursor
        ? `?start_cursor=${cursor}&page_size=100`
        : "?page_size=100";
      const response = await this.request(
        "GET",
        `/blocks/${pageId}/children${params}`
      );

      const results = response.results as Array<{ id: string; type: string }> | undefined ?? [];
      for (const block of results) {
        blocks.push({ id: block.id, type: block.type });
      }

      cursor = response.has_more ? response.next_cursor as string : undefined;
    } while (cursor);

    return blocks;
  }

  /**
   * Fetch all child blocks WITH full content (for pull-from-Notion).
   * Recursively fetches children for block types that support nesting.
   */
  async getBlocksWithContent(pageId: string): Promise<NotionApiBlock[]> {
    const NESTED_TYPES = new Set([
      "bulleted_list_item",
      "numbered_list_item",
      "to_do",
      "toggle",
      "callout",
      "quote",
      "column_list",
      "column",
    ]);

    const blocks: NotionApiBlock[] = [];
    let cursor: string | undefined;

    do {
      const params = cursor
        ? `?start_cursor=${cursor}&page_size=100`
        : "?page_size=100";
      const response = await this.request(
        "GET",
        `/blocks/${pageId}/children${params}`
      );

      const results = response.results as NotionApiBlock[] | undefined ?? [];
      for (const block of results) {
        if (block.has_children && NESTED_TYPES.has(block.type)) {
          block._children = await this.getBlocksWithContent(block.id);
        } else if (block.type === "table" && block.has_children) {
          block._children = await this.getBlocksWithContent(block.id);
        }
        blocks.push(block);
      }

      cursor = response.has_more ? response.next_cursor as string : undefined;
    } while (cursor);

    return blocks;
  }

  /**
   * Extract the plain-text title from a Notion page object.
   */
  getPageTitle(page: Record<string, unknown>): string {
    try {
      const props = page.properties as Record<string, unknown> | undefined;
      const titleProp = (props?.title as Record<string, unknown> | undefined)?.title;
      if (Array.isArray(titleProp) && titleProp.length > 0) {
        return titleProp
          .map((rt: unknown) => {
            const rtObj = rt as Record<string, unknown>;
            return (rtObj.plain_text as string) || ((rtObj.text as Record<string, unknown> | undefined)?.content as string) || "";
          })
          .join("");
      }
    } catch {
      // ignore parse errors, return default below
    }
    return "Untitled";
  }

  /** Archive (soft-delete) a page */
  async archivePage(pageId: string): Promise<void> {
    await this.request("PATCH", `/pages/${pageId}`, { archived: true });
  }

  /** Update page properties */
  async updatePageProperties(
    pageId: string,
    properties: Record<string, unknown>
  ): Promise<void> {
    await this.request("PATCH", `/pages/${pageId}`, { properties });
  }

  /** Retrieve a page; returns null if not found */
  async getPage(pageId: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.request("GET", `/pages/${pageId}`);
    } catch (error: unknown) {
      if ((error as NotionApiError)?.status === 404) return null;
      throw error;
    }
  }

  /** Search for pages by title */
  async searchPages(query: string): Promise<Record<string, unknown>[]> {
    const response = await this.request("POST", "/search", {
      query,
      filter: { property: "object", value: "page" },
      page_size: 20,
    });
    return response.results as Record<string, unknown>[] ?? [];
  }

  /**
   * Get child pages of a page (blocks of type "child_page").
   * Returns an array of {id, title} for each child page found.
   */
  async getChildPages(pageId: string): Promise<Array<{id: string, title: string}>> {
    const results: Array<{id: string, title: string}> = [];
    let cursor: string | undefined;

    do {
      const params = cursor
        ? `?start_cursor=${cursor}&page_size=100`
        : "?page_size=100";
      const response = await this.request(
        "GET",
        `/blocks/${pageId}/children${params}`
      );

      const blocks = response.results as NotionApiBlock[] | undefined ?? [];
      for (const block of blocks) {
        if (block.type === "child_page") {
          const childPage = block.child_page as { title?: string } | undefined;
          results.push({
            id: block.id,
            title: childPage?.title ?? "Untitled",
          });
        }
      }

      cursor = response.has_more ? response.next_cursor as string : undefined;
    } while (cursor);

    return results;
  }

  /** Test connection by retrieving the root page */
  async testConnection(rootPageId: string): Promise<boolean> {
    const page = await this.getPage(rootPageId);
    return page !== null;
  }

  destroy(): void {
    this.limiter.clear();
  }
}
