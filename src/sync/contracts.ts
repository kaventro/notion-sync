import type { NotionBlock, NotionApiBlock, PluginSettings } from "../types";

/**
 * The subset of the Notion REST API that sync services depend on.
 * Services depend on this abstraction rather than the concrete client,
 * so the API can be stubbed in tests or swapped out.
 */
export interface NotionApi {
  createPage(
    parentPageId: string,
    title: string,
    children?: NotionBlock[],
    properties?: Record<string, unknown>,
    icon?: string
  ): Promise<string>;
  appendBlocks(pageId: string, blocks: NotionBlock[]): Promise<void>;
  clearPageContent(pageId: string): Promise<void>;
  updatePageTitle(pageId: string, title: string): Promise<void>;
  getPage(pageId: string): Promise<Record<string, unknown> | null>;
  getBlocksWithContent(pageId: string): Promise<NotionApiBlock[]>;
  getChildPages(pageId: string): Promise<Array<{ id: string; title: string }>>;
  getPageTitle(page: Record<string, unknown>): string;
}

/**
 * Live accessor for plugin settings. The settings object is replaced
 * wholesale when the user edits options, so services must read through
 * this provider instead of capturing a reference at construction time.
 */
export type SettingsProvider = () => PluginSettings;

export interface SyncResult {
  synced: number;
  errors: number;
}

export interface PullResult {
  pulled: number;
  skipped: number;
  errors: number;
}

export interface ImportResult {
  created: number;
  errors: number;
}

export type PullFileResult = "pulled" | "no_change" | "not_mapped";
