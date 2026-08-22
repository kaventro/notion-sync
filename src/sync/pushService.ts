import type { App, TFile } from "obsidian";
import { Notice } from "obsidian";
import type { StateManager } from "../stateManager";
import type { SyncMapping } from "../types";
import { MarkdownParser } from "../markdownParser";
import type { LinkResolver } from "../linkResolver";
import type { AttachmentUploader } from "../attachmentUploader";
import type { NotionApi, SettingsProvider, SyncResult } from "./contracts";
import type { FolderHierarchySyncer } from "./folderHierarchySyncer";
import type { ProgressReporter } from "./progressReporter";
import type { StatePersister } from "./statePersister";
import type { SyncControl } from "./syncControl";
import { errMsg, hashContent } from "../utils";

export interface PushServiceDeps {
  app: App;
  notion: NotionApi;
  stateManager: StateManager;
  parser: MarkdownParser;
  linkResolver: LinkResolver;
  attachments: AttachmentUploader;
  folders: FolderHierarchySyncer;
  progress: ProgressReporter;
  persister: StatePersister;
  settings: SettingsProvider;
  control: SyncControl;
}

/**
 * Pushes vault content to Notion: full-vault, incremental (changed files
 * only), and single-file sync. Creates pages for unmapped files and
 * updates existing pages in place for mapped ones.
 */
export class PushService {
  constructor(private readonly deps: PushServiceDeps) {}

  /**
   * Sync the entire vault to Notion. Creates folder hierarchy and
   * syncs all markdown files.
   */
  async fullVault(): Promise<SyncResult> {
    const { stateManager, app, control, progress } = this.deps;
    let synced = 0;
    let errors = 0;

    try {
      stateManager.addLog("info", "Starting full vault sync");
      new Notice("Starting full vault sync...");

      // Phase 1: Create folder hierarchy
      await this.deps.folders.syncAll();

      // Phase 2: Sync all markdown files
      const mdFiles = app.vault.getMarkdownFiles();
      const total = mdFiles.length;

      for (let i = 0; i < mdFiles.length; i++) {
        if (control.aborted) {
          stateManager.addLog("warn", "Sync aborted by user");
          break;
        }

        const file = mdFiles[i];
        try {
          const didSync = await this.syncFile(file, false);
          if (didSync) {
            synced++;
            await this.deps.persister.persist();
          }

          // Progress notification every 25 files
          if ((i + 1) % 25 === 0) {
            new Notice(`Syncing... ${i + 1}/${total}`);
          }
          // Report progress callback every 10 files
          if ((i + 1) % 10 === 0 || i === mdFiles.length - 1) {
            const pct = Math.round(((i + 1) / total) * 100);
            progress.report(`Syncing ${i + 1}/${total}...`, pct);
          }
        } catch (error) {
          errors++;
          stateManager.addLog("error", `Failed to sync: ${errMsg(error)}`, file.path);
        }
      }

      // Phase 3: Resolve internal links (second pass)
      await this.resolveAllLinks(mdFiles);

      stateManager.setLastFullSync(Date.now());
      stateManager.addLog(
        "info",
        `Full sync complete: ${synced} synced, ${errors} errors`
      );
      new Notice(`Sync complete: ${synced} files synced, ${errors} errors`);
    } catch (error) {
      stateManager.addLog("error", `Full sync failed: ${errMsg(error)}`);
      new Notice(`Sync failed: ${errMsg(error)}`);
    }

    return { synced, errors };
  }

  /**
   * Only sync files that have changed since last sync.
   * Uses content hashing to detect changes.
   */
  async incremental(): Promise<SyncResult> {
    const { stateManager, app, control } = this.deps;
    let synced = 0;
    let errors = 0;

    try {
      stateManager.addLog("info", "Starting incremental sync");

      // Ensure folder hierarchy is up to date
      await this.deps.folders.syncAll();

      const mdFiles = app.vault.getMarkdownFiles();

      for (const file of mdFiles) {
        if (control.aborted) break;

        try {
          const content = await app.vault.cachedRead(file);
          const hash = hashContent(content);
          const mapping = stateManager.getFileMapping(file.path);

          if (stateManager.needsSync(file.path, hash)) {
            await this.syncFile(file, false);
            synced++;
            await this.deps.persister.persist();
          } else if (mapping && mapping.lastSyncedTitle !== file.basename) {
            // Content unchanged but the note was renamed — push just the title.
            if (await this.syncTitleOnly(file, mapping)) synced++;
            await this.deps.persister.persist();
          }
        } catch (error) {
          errors++;
          stateManager.addLog("error", `Incremental sync failed: ${errMsg(error)}`, file.path);
        }
      }

      // Handle deleted files: remove mappings for files no longer in vault
      this.cleanupDeletedFiles(mdFiles);

      if (synced > 0) {
        await this.resolveAllLinks(mdFiles);
      }

      stateManager.addLog("info", `Incremental sync: ${synced} updated, ${errors} errors`);
      new Notice(`Incremental sync: ${synced} updated, ${errors} errors`);
    } catch (error) {
      stateManager.addLog("error", `Incremental sync failed: ${errMsg(error)}`);
      new Notice(`Sync failed: ${errMsg(error)}`);
    }

    return { synced, errors };
  }

  /** Sync a single file to Notion. */
  async currentFile(file: TFile): Promise<boolean> {
    try {
      // Ensure parent folders exist
      await this.deps.folders.ensureParentFolders(file);

      const didSync = await this.syncFile(file, true);
      if (didSync) {
        new Notice(`Synced: ${file.basename}`);
      }
      return didSync;
    } catch (error) {
      this.deps.stateManager.addLog("error", `Failed to sync: ${errMsg(error)}`, file.path);
      new Notice(`Sync failed: ${errMsg(error)}`);
      return false;
    }
  }

  /**
   * Sync a single markdown file to Notion.
   * Creates or updates the corresponding Notion page.
   */
  private async syncFile(file: TFile, resolveLinks: boolean): Promise<boolean> {
    const { app, notion, stateManager } = this.deps;
    const settings = this.deps.settings();

    const content = await app.vault.cachedRead(file);
    const hash = hashContent(content);

    // Parse content
    const body = MarkdownParser.stripFrontmatter(content);
    let blocks = this.deps.parser.parse(body);

    // Resolve internal links if requested
    if (resolveLinks) {
      blocks = this.deps.linkResolver.resolveBlockLinks(blocks, content);
    }

    // Process attachments
    if (settings.syncAttachments) {
      blocks = await this.deps.attachments.processBlocks(blocks, file.path);
    }

    // Determine parent page
    const parentPageId = this.deps.folders.getParentPageId(file);

    // Check if page already exists
    const existingMapping = stateManager.getFileMapping(file.path);

    if (existingMapping) {
      // Update: rename the page if needed, then clear content and re-append
      try {
        await this.pushTitle(file, existingMapping);

        await notion.clearPageContent(existingMapping.notionPageId);
        if (blocks.length > 0) {
          await notion.appendBlocks(existingMapping.notionPageId, blocks);
        }

        // Update metadata properties
        if (settings.syncMetadata) {
          this.syncMetadata(existingMapping.notionPageId, content);
        }

        stateManager.setFileMapping(file.path, {
          notionPageId: existingMapping.notionPageId,
          lastSyncedHash: hash,
          lastSyncedAt: Date.now(),
          lastSyncedTitle: file.basename,
        });

        // Add history entry for push
        stateManager.addHistoryEntry({
          timestamp: Date.now(),
          operation: "push",
          filePath: file.path,
          fileName: file.basename,
        });

        stateManager.addLog("info", `Updated: ${file.path}`, file.path);
        return true;
      } catch (error) {
        // If the page is gone from Notion (deleted or sitting in the
        // trash after the user cleaned up), drop the stale mapping and
        // fall through to create a fresh page.
        if (this.isPageGoneError(error)) {
          stateManager.removeFileMapping(file.path);
          stateManager.addLog(
            "info",
            `Notion page missing or archived — recreating: ${file.path}`,
            file.path
          );
        } else {
          throw error;
        }
      }
    }

    // Create new page
    const pageId = await notion.createPage(parentPageId, file.basename, blocks);

    // Sync metadata
    if (settings.syncMetadata) {
      this.syncMetadata(pageId, content);
    }

    stateManager.setFileMapping(file.path, {
      notionPageId: pageId,
      lastSyncedHash: hash,
      lastSyncedAt: Date.now(),
      lastSyncedTitle: file.basename,
    });

    // Add history entry for push (new page created)
    stateManager.addHistoryEntry({
      timestamp: Date.now(),
      operation: "push",
      filePath: file.path,
      fileName: file.basename,
    });

    stateManager.addLog("info", `Created: ${file.path}`, file.path);
    return true;
  }

  /**
   * Rename the Notion page when the note's basename no longer matches the
   * title we last pushed. Skipped when they already match, so a normal
   * content sync costs no extra request.
   */
  private async pushTitle(file: TFile, mapping: SyncMapping): Promise<boolean> {
    if (mapping.lastSyncedTitle === file.basename) return false;

    await this.deps.notion.updatePageTitle(mapping.notionPageId, file.basename);

    // An undefined previous title means the mapping predates title sync;
    // that is a one-off backfill, not a rename worth reporting.
    const renamed = mapping.lastSyncedTitle !== undefined;
    if (renamed) {
      this.deps.stateManager.addLog(
        "info",
        `Renamed in Notion: ${mapping.lastSyncedTitle} → ${file.basename}`,
        file.path
      );
    }
    return renamed;
  }

  /**
   * Push only the page title for a note whose content is already in sync.
   * Renaming a note leaves its content untouched, so an incremental sync
   * would otherwise skip it and the Notion page would keep the old name.
   */
  private async syncTitleOnly(file: TFile, mapping: SyncMapping): Promise<boolean> {
    const { stateManager } = this.deps;
    try {
      const renamed = await this.pushTitle(file, mapping);

      stateManager.setFileMapping(file.path, {
        ...mapping,
        lastSyncedAt: Date.now(),
        lastSyncedTitle: file.basename,
      });

      if (renamed) {
        stateManager.addHistoryEntry({
          timestamp: Date.now(),
          operation: "push",
          filePath: file.path,
          fileName: file.basename,
        });
      }

      return renamed;
    } catch (error) {
      // Page gone from Notion: drop the stale mapping so the next sync
      // recreates the page instead of failing on every run.
      if (this.isPageGoneError(error)) {
        stateManager.removeFileMapping(file.path);
        stateManager.addLog(
          "info",
          `Notion page missing or archived — will be recreated: ${file.path}`,
          file.path
        );
        return false;
      }
      throw error;
    }
  }

  /**
   * Whether an error from a page edit means the target page no longer
   * exists for our purposes: hard-deleted (404) or moved to the Notion
   * trash (400 "archived ancestor" validation error).
   */
  private isPageGoneError(error: unknown): boolean {
    const status = (error as { status?: number })?.status;
    if (status === 404) return true;
    return status === 400 && /archiv/i.test(errMsg(error));
  }

  /**
   * Extract frontmatter and sync as Notion page properties.
   */
  private syncMetadata(_pageId: string, _content: string): void {
    // Frontmatter sync to Notion page properties is not yet implemented
  }

  /**
   * Resolve all internal links across synced files (second pass).
   */
  private async resolveAllLinks(files: TFile[]): Promise<void> {
    const { app, notion, stateManager, control } = this.deps;
    stateManager.addLog("info", "Resolving internal links...");

    for (const file of files) {
      if (control.aborted) break;

      const mapping = stateManager.getFileMapping(file.path);
      if (!mapping) continue;

      try {
        const content = await app.vault.cachedRead(file);
        const linkMap = this.deps.linkResolver.resolveLinks(content);

        if (linkMap.size > 0) {
          // Re-parse and re-sync with resolved links
          const body = MarkdownParser.stripFrontmatter(content);
          let blocks = this.deps.parser.parse(body);
          blocks = this.deps.linkResolver.resolveBlockLinks(blocks, content);

          if (this.deps.settings().syncAttachments) {
            blocks = await this.deps.attachments.processBlocks(blocks, file.path);
          }

          await notion.clearPageContent(mapping.notionPageId);
          if (blocks.length > 0) {
            await notion.appendBlocks(mapping.notionPageId, blocks);
          }
        }
      } catch (error) {
        stateManager.addLog("warn", `Link resolution failed: ${errMsg(error)}`, file.path);
      }
    }
  }

  /**
   * Remove mappings for files that no longer exist in the vault.
   */
  private cleanupDeletedFiles(currentFiles: TFile[]): void {
    const { stateManager } = this.deps;
    const currentPaths = new Set(currentFiles.map((f) => f.path));
    const allMappings = stateManager.getAllFileMappings();

    for (const path of Object.keys(allMappings)) {
      if (!currentPaths.has(path)) {
        stateManager.removeFileMapping(path);
        stateManager.addLog("info", `Removed mapping for deleted: ${path}`);
      }
    }
  }
}
