import type { App } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { Notice, requestUrl } from "obsidian";
import { NotionClient } from "./notionClient";
import { MarkdownParser } from "./markdownParser";
import { NotionToMarkdown } from "./notionToMarkdown";
import { LinkResolver } from "./linkResolver";
import { AttachmentUploader } from "./attachmentUploader";
import { StateManager, normalizeNotionId } from "./stateManager";
import type { PluginSettings } from "./types";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Orchestrates synchronization between the Obsidian vault and Notion.
 * Supports full sync, incremental sync, and single-file sync.
 */
export class SyncEngine {
  private app: App;
  private settings: PluginSettings;
  private notionClient: NotionClient;
  private parser: MarkdownParser;
  private n2md: NotionToMarkdown;
  private linkResolver: LinkResolver;
  private attachmentUploader: AttachmentUploader;
  private stateManager: StateManager;
  private isSyncing = false;
  private abortRequested = false;

  // ── Progress callback ──────────────────────────────────────
  private progressCallback: ((text: string, percent: number) => void) | null = null;

  setProgressCallback(cb: ((text: string, percent: number) => void) | null): void {
    this.progressCallback = cb;
  }

  private reportProgress(text: string, percent: number): void {
    this.progressCallback?.(text, percent);
  }

  // ── Persist callback ───────────────────────────────────────
  // Saves mappings to disk incrementally during a sync. Without this,
  // an interrupted sync (crash, app quit) loses every mapping created so
  // far and the next sync re-creates the same pages in Notion.
  private persistCallback: (() => Promise<void>) | null = null;

  setPersistCallback(cb: (() => Promise<void>) | null): void {
    this.persistCallback = cb;
  }

  private async persistState(): Promise<void> {
    try {
      await this.persistCallback?.();
    } catch (e) {
      this.stateManager.addLog("warn", `Failed to persist state: ${errMsg(e)}`);
    }
  }

  constructor(
    app: App,
    settings: PluginSettings,
    stateManager: StateManager
  ) {
    this.app = app;
    this.settings = settings;
    this.stateManager = stateManager;
    this.notionClient = new NotionClient(settings.notionToken);
    this.parser = new MarkdownParser();
    this.n2md = new NotionToMarkdown();
    this.linkResolver = new LinkResolver(app, stateManager, this.notionClient);
    this.attachmentUploader = new AttachmentUploader(
      app,
      stateManager,
      settings.attachmentUploadUrl
    );
  }

  /** Update references when settings change */
  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
    this.notionClient.updateToken(settings.notionToken);
    this.attachmentUploader.setUploadUrl(settings.attachmentUploadUrl);
  }

  /** Whether a sync is currently in progress */
  get syncing(): boolean {
    return this.isSyncing;
  }

  /** Request abort of current sync */
  abort(): void {
    this.abortRequested = true;
  }

  // ── Full Vault Sync ────────────────────────────────────────

  /**
   * Sync the entire vault to Notion. Creates folder hierarchy and
   * syncs all markdown files.
   */
  async syncFullVault(): Promise<{ synced: number; errors: number }> {
    if (this.isSyncing) {
      new Notice("Sync already in progress");
      return { synced: 0, errors: 0 };
    }

    if (!this.validateSettings()) return { synced: 0, errors: 0 };

    this.isSyncing = true;
    this.abortRequested = false;
    let synced = 0;
    let errors = 0;

    try {
      this.stateManager.addLog("info", "Starting full vault sync");
      new Notice("Starting full vault sync...");

      // Phase 1: Create folder hierarchy
      await this.syncFolderHierarchy();

      // Phase 2: Sync all markdown files
      const mdFiles = this.app.vault.getMarkdownFiles();
      const total = mdFiles.length;

      for (let i = 0; i < mdFiles.length; i++) {
        if (this.abortRequested) {
          this.stateManager.addLog("warn", "Sync aborted by user");
          break;
        }

        const file = mdFiles[i];
        try {
          const didSync = await this.syncFile(file, false);
          if (didSync) {
            synced++;
            await this.persistState();
          }

          // Progress notification every 25 files
          if ((i + 1) % 25 === 0) {
            new Notice(`Syncing... ${i + 1}/${total}`);
          }
          // Report progress callback every 10 files
          if ((i + 1) % 10 === 0 || i === mdFiles.length - 1) {
            const pct = Math.round(((i + 1) / total) * 100);
            this.reportProgress(`Syncing ${i + 1}/${total}...`, pct);
          }
        } catch (error) {
          errors++;
          this.stateManager.addLog(
            "error",
            `Failed to sync: ${errMsg(error)}`,
            file.path
          );
        }
      }

      // Phase 3: Resolve internal links (second pass)
      await this.resolveAllLinks(mdFiles);

      this.stateManager.setLastFullSync(Date.now());
      this.stateManager.addLog(
        "info",
        `Full sync complete: ${synced} synced, ${errors} errors`
      );
      new Notice(`Sync complete: ${synced} files synced, ${errors} errors`);
    } catch (error) {
      this.stateManager.addLog("error", `Full sync failed: ${errMsg(error)}`);
      new Notice(`Sync failed: ${errMsg(error)}`);
    } finally {
      this.isSyncing = false;
    }

    return { synced, errors };
  }

  // ── Incremental Sync ───────────────────────────────────────

  /**
   * Only sync files that have changed since last sync.
   * Uses content hashing to detect changes.
   */
  async syncIncremental(): Promise<{ synced: number; errors: number }> {
    if (this.isSyncing) {
      new Notice("Sync already in progress");
      return { synced: 0, errors: 0 };
    }

    if (!this.validateSettings()) return { synced: 0, errors: 0 };

    this.isSyncing = true;
    this.abortRequested = false;
    let synced = 0;
    let errors = 0;

    try {
      this.stateManager.addLog("info", "Starting incremental sync");

      // Ensure folder hierarchy is up to date
      await this.syncFolderHierarchy();

      const mdFiles = this.app.vault.getMarkdownFiles();

      for (const file of mdFiles) {
        if (this.abortRequested) break;

        try {
          const content = await this.app.vault.cachedRead(file);
          const hash = this.hashContent(content);

          if (this.stateManager.needsSync(file.path, hash)) {
            await this.syncFile(file, false);
            synced++;
            await this.persistState();
          }
        } catch (error) {
          errors++;
          this.stateManager.addLog(
            "error",
            `Incremental sync failed: ${errMsg(error)}`,
            file.path
          );
        }
      }

      // Handle deleted files: remove mappings for files no longer in vault
      this.cleanupDeletedFiles(mdFiles);

      if (synced > 0) {
        await this.resolveAllLinks(mdFiles);
      }

      this.stateManager.addLog(
        "info",
        `Incremental sync: ${synced} updated, ${errors} errors`
      );
      new Notice(`Incremental sync: ${synced} updated, ${errors} errors`);
    } catch (error) {
      this.stateManager.addLog("error", `Incremental sync failed: ${errMsg(error)}`);
      new Notice(`Sync failed: ${errMsg(error)}`);
    } finally {
      this.isSyncing = false;
    }

    return { synced, errors };
  }

  // ── Single File Sync ───────────────────────────────────────

  /**
   * Sync a single file to Notion.
   */
  async syncCurrentFile(file: TFile): Promise<boolean> {
    if (this.isSyncing) {
      new Notice("Sync already in progress");
      return false;
    }

    if (!this.validateSettings()) return false;

    this.isSyncing = true;
    try {
      // Ensure parent folders exist
      await this.ensureParentFolders(file);

      const didSync = await this.syncFile(file, true);
      if (didSync) {
        new Notice(`Synced: ${file.basename}`);
      }
      return didSync;
    } catch (error) {
      this.stateManager.addLog(
        "error",
        `Failed to sync: ${errMsg(error)}`,
        file.path
      );
      new Notice(`Sync failed: ${errMsg(error)}`);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  // ── Rebuild Hierarchy ──────────────────────────────────────

  /**
   * Completely rebuild the Notion page hierarchy from scratch.
   * Clears all existing mappings and recreates everything.
   */
  async rebuildHierarchy(): Promise<void> {
    if (this.isSyncing) {
      new Notice("Sync already in progress");
      return;
    }

    this.isSyncing = true;
    try {
      this.stateManager.addLog("info", "Rebuilding Notion hierarchy");
      new Notice("Rebuilding hierarchy... This may take a while.");

      this.stateManager.reset();
      await this.syncFullVault();
    } finally {
      this.isSyncing = false;
    }
  }

  // ── Pull from Notion ───────────────────────────────────────

  /**
   * Pull a single file from Notion → always overwrites the local file.
   * No conflict detection — Notion is the source of truth when pulling.
   *
   * 'pulled'     – file overwritten from Notion
   * 'no_change'  – Notion hasn't changed since last sync
   * 'not_mapped' – no Notion page mapped for this file
   */
  async pullCurrentFile(
    file: TFile
  ): Promise<"pulled" | "no_change" | "not_mapped"> {
    if (!this.validateSettings()) return "not_mapped";

    const mapping = this.stateManager.getFileMapping(file.path);
    if (!mapping) return "not_mapped";

    const page = await this.notionClient.getPage(mapping.notionPageId);
    if (!page || page.archived) return "not_mapped";

    // Save snapshot before overwriting
    const snapshot = await this.app.vault.cachedRead(file);
    this.stateManager.addHistoryEntry({
      timestamp: Date.now(),
      operation: "pull",
      filePath: file.path,
      fileName: file.basename,
      snapshot,
    });

    // Always fetch and overwrite — no conflict check
    const blocks = await this.notionClient.getBlocksWithContent(mapping.notionPageId);
    const rawMarkdown = this.n2md.convert(blocks);
    // Convert Notion page URLs back to Obsidian [[wiki-links]]
    let markdown = this.restoreWikiLinks(rawMarkdown);

    // Download images if setting is enabled
    if (this.settings.downloadImages) {
      markdown = await this.downloadNotionImages(markdown, file.path);
    }

    await this.app.vault.modify(file, markdown);

    const newHash = this.hashContent(markdown);
    this.stateManager.setFileMapping(file.path, {
      ...mapping,
      lastSyncedHash: newHash,
      lastSyncedAt: Date.now(),
    });

    this.stateManager.addLog("info", `Pulled from Notion: ${file.path}`, file.path);
    return "pulled";
  }

  /**
   * Pull all mapped files from Notion — always overwrites local files.
   */
  async pullAll(): Promise<{ pulled: number; skipped: number; errors: number }> {
    if (this.isSyncing) {
      new Notice("Sync already in progress");
      return { pulled: 0, skipped: 0, errors: 0 };
    }
    if (!this.validateSettings()) return { pulled: 0, skipped: 0, errors: 0 };

    this.isSyncing = true;
    this.abortRequested = false;
    let pulled = 0, skipped = 0, errors = 0;

    try {
      this.stateManager.addLog("info", "Starting pull from Notion");
      new Notice("Pulling from Notion...");

      const allMappings = this.stateManager.getAllFileMappings();
      const entries = Object.entries(allMappings);
      const total = entries.length;

      for (let i = 0; i < entries.length; i++) {
        if (this.abortRequested) break;

        const [filePath] = entries[i];
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
          skipped++;
          continue;
        }

        try {
          const result = await this.pullCurrentFile(file);
          if (result === "pulled") pulled++;
          else skipped++;

          if ((i + 1) % 5 === 0 || i === entries.length - 1) {
            const pct = Math.round(((i + 1) / total) * 100);
            this.reportProgress(`Pulling ${i + 1}/${total}...`, pct);
          }
        } catch (e) {
          errors++;
          this.stateManager.addLog("error", `Pull failed: ${errMsg(e)}`, filePath);
        }
      }

      const msg = `Pull complete: ${pulled} updated, ${errors} errors`;
      this.stateManager.addLog("info", msg);
      new Notice(msg);
    } catch (e) {
      this.stateManager.addLog("error", `Pull failed: ${errMsg(e)}`);
      new Notice(`Pull failed: ${errMsg(e)}`);
    } finally {
      this.isSyncing = false;
    }

    return { pulled, skipped, errors };
  }

  // ── Pull New Pages from Notion ─────────────────────────────

  /**
   * Recursively traverse Notion pages under rootPageId and create local files
   * for pages not yet in any file mapping.
   */
  async pullNewPages(): Promise<{ created: number; errors: number }> {
    if (this.isSyncing) {
      new Notice("Sync already in progress");
      return { created: 0, errors: 0 };
    }
    if (!this.validateSettings()) return { created: 0, errors: 0 };

    this.isSyncing = true;
    this.abortRequested = false;
    let created = 0;
    let errors = 0;

    try {
      this.stateManager.addLog("info", "Starting pull new pages from Notion");
      new Notice("Pulling new pages from Notion...");

      // Build set of all already-known Notion page IDs
      const knownIds = new Set<string>();
      for (const mapping of Object.values(this.stateManager.getAllFileMappings())) {
        knownIds.add(normalizeNotionId(mapping.notionPageId));
      }

      // Traverse recursively
      const result = await this.traverseAndCreatePages(
        this.settings.rootPageId,
        "",
        knownIds,
        0,
        created,
        errors
      );
      created = result.created;
      errors = result.errors;

      const msg = `Pull new pages complete: ${created} created, ${errors} errors`;
      this.stateManager.addLog("info", msg);
      new Notice(msg);
    } catch (e) {
      this.stateManager.addLog("error", `Pull new pages failed: ${errMsg(e)}`);
      new Notice(`Pull new pages failed: ${errMsg(e)}`);
    } finally {
      this.isSyncing = false;
    }

    return { created, errors };
  }

  /**
   * Recursively traverse child pages. For each unknown page, create a local file.
   */
  private async traverseAndCreatePages(
    notionPageId: string,
    parentFolderPath: string,
    knownIds: Set<string>,
    depth: number,
    created: number,
    errors: number
  ): Promise<{ created: number; errors: number }> {
    if (this.abortRequested || depth > 20) return { created, errors };

    let childPages: Array<{id: string, title: string}>;
    try {
      childPages = await this.notionClient.getChildPages(notionPageId);
    } catch (e) {
      this.stateManager.addLog("warn", `Could not fetch children of ${notionPageId}: ${errMsg(e)}`);
      return { created, errors };
    }

    const folderMappings = this.stateManager.getAllFolderMappings();
    // Build reverse map: notionPageId -> folderPath
    const notionIdToFolder: Record<string, string> = {};
    for (const [folderPath, nId] of Object.entries(folderMappings)) {
      notionIdToFolder[normalizeNotionId(nId)] = folderPath;
    }

    // Determine the folder that corresponds to notionPageId
    let currentFolder = parentFolderPath;
    if (depth > 0) {
      const resolvedFolder = notionIdToFolder[normalizeNotionId(notionPageId)];
      if (resolvedFolder) {
        currentFolder = resolvedFolder;
      }
    }

    const total = childPages.length;

    for (let i = 0; i < childPages.length; i++) {
      if (this.abortRequested) break;

      const child = childPages[i];
      const normalizedId = normalizeNotionId(child.id);

      // Report progress
      if (total > 0) {
        const pct = Math.round((i / total) * 100);
        this.reportProgress(`Checking pages... ${child.title}`, pct);
      }

      // Check if this page has further child pages (to decide folder mapping)
      let grandChildren: Array<{id: string, title: string}> = [];
      try {
        grandChildren = await this.notionClient.getChildPages(child.id);
      } catch {
        // ignore
      }

      const hasChildren = grandChildren.length > 0;

      // If this page has children, register it as a folder mapping too
      if (hasChildren) {
        const safeFolderName = this.sanitizeFileName(child.title);
        const folderPath = currentFolder
          ? `${currentFolder}/${safeFolderName}`
          : safeFolderName;

        if (!this.stateManager.getFolderMapping(folderPath)) {
          this.stateManager.setFolderMapping(folderPath, child.id);
          // Ensure folder exists in vault
          try {
            const existing = this.app.vault.getAbstractFileByPath(folderPath);
            if (!existing) {
              await this.app.vault.createFolder(folderPath);
            }
          } catch {
            // folder may already exist
          }
        }
      }

      // Only create a file if this page is NOT already in our mappings
      if (!knownIds.has(normalizedId)) {
        try {
          // Fetch blocks and convert to markdown
          const blocks = await this.notionClient.getBlocksWithContent(child.id);
          const rawMarkdown = this.n2md.convert(blocks);
          let markdown = this.restoreWikiLinks(rawMarkdown);

          // Download images if enabled
          if (this.settings.downloadImages) {
            const safeTitle = this.sanitizeFileName(child.title);
            const tempFilePath = currentFolder
              ? `${currentFolder}/${safeTitle}.md`
              : `${safeTitle}.md`;
            markdown = await this.downloadNotionImages(markdown, tempFilePath);
          }

          // Determine file path
          const safeFileName = this.sanitizeFileName(child.title);
          const baseFolder = currentFolder;
          const filePath = this.findUniquePath(
            baseFolder ? `${baseFolder}/${safeFileName}.md` : `${safeFileName}.md`
          );

          // Ensure parent folder exists
          const parts = filePath.split("/");
          parts.pop();
          if (parts.length > 0) {
            const dir = parts.join("/");
            const existing = this.app.vault.getAbstractFileByPath(dir);
            if (!existing) {
              try {
                await this.app.vault.createFolder(dir);
              } catch {
                // may already exist
              }
            }
          }

          await this.app.vault.create(filePath, markdown);

          const hash = this.hashContent(markdown);
          this.stateManager.setFileMapping(filePath, {
            notionPageId: child.id,
            lastSyncedHash: hash,
            lastSyncedAt: Date.now(),
          });
          await this.persistState();

          // Add to known IDs so we don't create it again
          knownIds.add(normalizedId);

          // Add history entry
          this.stateManager.addHistoryEntry({
            timestamp: Date.now(),
            operation: "pull-new",
            filePath,
            fileName: safeFileName,
          });

          this.stateManager.addLog("info", `Created from Notion: ${filePath}`, filePath);
          created++;
        } catch (e) {
          errors++;
          this.stateManager.addLog("error", `Failed to create page ${child.title}: ${errMsg(e)}`);
        }
      }

      // Recurse into child pages
      if (hasChildren) {
        const folderMappingsNow = this.stateManager.getAllFolderMappings();
        const notionIdToFolderNow: Record<string, string> = {};
        for (const [fp, nid] of Object.entries(folderMappingsNow)) {
          notionIdToFolderNow[normalizeNotionId(nid)] = fp;
        }
        const childFolder = notionIdToFolderNow[normalizeNotionId(child.id)] || currentFolder;

        const sub = await this.traverseAndCreatePages(
          child.id,
          childFolder,
          knownIds,
          depth + 1,
          created,
          errors
        );
        created = sub.created;
        errors = sub.errors;
      }
    }

    return { created, errors };
  }

  // ── Download Notion Images ─────────────────────────────────

  /**
   * Find all Notion/S3 image URLs in markdown, download them to the vault,
   * and replace with Obsidian ![[filename]] embeds.
   */
  private async downloadNotionImages(markdown: string, filePath: string): Promise<string> {
    // Match ![caption](url) where url starts with https:// and contains notion.so or amazonaws.com
    const imageRegex = /!\[([^\]]*)\]\((https:\/\/[^)]*(?:notion\.so|amazonaws\.com)[^)]*)\)/g;

    const matches: Array<{ full: string; caption: string; url: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = imageRegex.exec(markdown)) !== null) {
      matches.push({ full: m[0], caption: m[1], url: m[2] });
    }

    if (matches.length === 0) return markdown;

    // Determine attachment folder
    const fileDir = filePath.includes("/")
      ? filePath.substring(0, filePath.lastIndexOf("/"))
      : "";
    const attachmentFolder = fileDir
      ? `${fileDir}/_attachments`
      : "_attachments";

    // Ensure attachment folder exists
    const existingFolder = this.app.vault.getAbstractFileByPath(attachmentFolder);
    if (!existingFolder) {
      try {
        await this.app.vault.createFolder(attachmentFolder);
      } catch {
        // may already exist
      }
    }

    let result = markdown;

    for (const { full, url } of matches) {
      try {
        // Extract filename from URL
        let fileName = this.extractFileNameFromUrl(url);
        if (!fileName) continue;

        // Ensure unique filename in attachment folder
        fileName = this.findUniqueAttachmentName(attachmentFolder, fileName);
        const attachmentPath = `${attachmentFolder}/${fileName}`;

        // Download the image
        const resp = await requestUrl({ url, method: "GET", throw: false });
        if (resp.status < 200 || resp.status >= 300) {
          this.stateManager.addLog("warn", `Failed to download image: ${url} (status ${resp.status})`);
          continue;
        }

        // Check if file already exists before creating
        const existingFile = this.app.vault.getAbstractFileByPath(attachmentPath);
        if (!existingFile) {
          await this.app.vault.createBinary(attachmentPath, resp.arrayBuffer);
        }

        // Replace URL with Obsidian embed
        result = result.replace(full, `![[${fileName}]]`);
      } catch (e) {
        this.stateManager.addLog("warn", `Image download failed: ${errMsg(e)}`);
      }
    }

    return result;
  }

  /** Extract a sanitized filename from a URL */
  private extractFileNameFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const pathParts = parsed.pathname.split("/");
      let name = pathParts[pathParts.length - 1] || "image";
      // Remove query params from name
      name = name.split("?")[0];
      // Sanitize
      name = name.replace(/[^\w.-]/g, "_");
      // Ensure it has an extension
      if (!name.includes(".")) {
        name += ".png";
      }
      // Truncate if too long
      if (name.length > 64) {
        const ext = name.substring(name.lastIndexOf("."));
        name = name.substring(0, 60 - ext.length) + ext;
      }
      return name;
    } catch {
      return "image.png";
    }
  }

  /** Ensure a unique filename in the attachment folder */
  private findUniqueAttachmentName(folder: string, fileName: string): string {
    const ext = fileName.includes(".") ? fileName.substring(fileName.lastIndexOf(".")) : "";
    const base = fileName.includes(".") ? fileName.substring(0, fileName.lastIndexOf(".")) : fileName;

    let candidate = fileName;
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(`${folder}/${candidate}`)) {
      candidate = `${base} (${n})${ext}`;
      n++;
    }
    return candidate;
  }

  /** Find a unique file path by appending (1), (2) etc. */
  private findUniquePath(filePath: string): string {
    const ext = filePath.includes(".") ? filePath.substring(filePath.lastIndexOf(".")) : "";
    const base = filePath.includes(".") ? filePath.substring(0, filePath.lastIndexOf(".")) : filePath;

    let candidate = filePath;
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${base} (${n})${ext}`;
      n++;
    }
    return candidate;
  }

  /** Sanitize a title to use as a filename */
  private sanitizeFileName(name: string): string {
    return name
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 100)
      || "Untitled";
  }

  // ── Wiki-link Restoration ──────────────────────────────────

  /**
   * After pulling from Notion, replace Notion page URLs with Obsidian [[wiki-links]].
   *
   * Notion stores internal links as:
   *   [Page Title](https://www.notion.so/Title-339ee678f579814aa880dad31be33d8e)
   * or just:
   *   [Page Title](https://www.notion.so/339ee678f579814aa880dad31be33d8e)
   *
   * We look up the page ID in our stateManager reverse map and convert back to [[filename]].
   */
  restoreWikiLinks(markdown: string): string {
    // Match [any text](https://www.notion.so/...ID) where ID is 32 hex chars at the end
    return markdown.replace(
      /\[([^\]]*)\]\(https:\/\/(?:www\.)?notion\.so\/[^\s)]*?([0-9a-f]{32})\)/gi,
      (_match: string, linkText: string, rawId: string) => {
        const filePath = this.stateManager.getFilePathByNotionId(rawId);
        if (!filePath) return _match; // not in our vault — keep as-is

        // Use just the filename without extension as the wiki-link target
        const fileName = filePath.split("/").pop()?.replace(/\.md$/, "") || linkText;

        // If the display text differs from the file name, add an alias: [[target|alias]]
        const cleanText = linkText.replace(/^[^\w]*/, "").trim(); // strip leading emoji/spaces
        if (cleanText && cleanText !== fileName) {
          return `[[${fileName}|${cleanText}]]`;
        }
        return `[[${fileName}]]`;
      }
    );
  }

  // ── Internal Methods ───────────────────────────────────────

  /**
   * Sync a single markdown file to Notion.
   * Creates or updates the corresponding Notion page.
   */
  private async syncFile(
    file: TFile,
    resolveLinks: boolean
  ): Promise<boolean> {
    const content = await this.app.vault.cachedRead(file);
    const hash = this.hashContent(content);

    // Parse content
    const body = MarkdownParser.stripFrontmatter(content);
    let blocks = this.parser.parse(body);

    // Resolve internal links if requested
    if (resolveLinks) {
      blocks = this.linkResolver.resolveBlockLinks(blocks, content);
    }

    // Process attachments
    if (this.settings.syncAttachments) {
      blocks = await this.attachmentUploader.processBlocks(blocks, file.path);
    }

    // Determine parent page
    const parentPageId = this.getParentPageId(file);

    // Check if page already exists
    const existingMapping = this.stateManager.getFileMapping(file.path);

    if (existingMapping) {
      // Update: clear existing content and re-append
      try {
        await this.notionClient.clearPageContent(existingMapping.notionPageId);
        if (blocks.length > 0) {
          await this.notionClient.appendBlocks(
            existingMapping.notionPageId,
            blocks
          );
        }

        // Update metadata properties
        if (this.settings.syncMetadata) {
          this.syncMetadata(existingMapping.notionPageId, content);
        }

        this.stateManager.setFileMapping(file.path, {
          notionPageId: existingMapping.notionPageId,
          lastSyncedHash: hash,
          lastSyncedAt: Date.now(),
        });

        // Add history entry for push
        this.stateManager.addHistoryEntry({
          timestamp: Date.now(),
          operation: "push",
          filePath: file.path,
          fileName: file.basename,
        });

        this.stateManager.addLog("info", `Updated: ${file.path}`, file.path);
        return true;
      } catch (error) {
        // If page was deleted in Notion, create a new one
        if ((error as { status?: number })?.status === 404) {
          this.stateManager.removeFileMapping(file.path);
        } else {
          throw error;
        }
      }
    }

    // Create new page
    const pageId = await this.notionClient.createPage(
      parentPageId,
      file.basename,
      blocks
    );

    // Sync metadata
    if (this.settings.syncMetadata) {
      this.syncMetadata(pageId, content);
    }

    this.stateManager.setFileMapping(file.path, {
      notionPageId: pageId,
      lastSyncedHash: hash,
      lastSyncedAt: Date.now(),
    });

    // Add history entry for push (new page created)
    this.stateManager.addHistoryEntry({
      timestamp: Date.now(),
      operation: "push",
      filePath: file.path,
      fileName: file.basename,
    });

    this.stateManager.addLog("info", `Created: ${file.path}`, file.path);
    return true;
  }

  /**
   * Create the Notion page hierarchy mirroring the vault's folder structure.
   */
  private async syncFolderHierarchy(): Promise<void> {
    const rootFolder = this.app.vault.getRoot();
    await this.syncFolder(rootFolder, this.settings.rootPageId);
  }

  private async syncFolder(
    folder: TFolder,
    parentNotionId: string
  ): Promise<void> {
    for (const child of folder.children) {
      if (this.abortRequested) return;

      if (!(child instanceof TFolder)) continue;

      const subFolder = child;

      // Skip hidden folders
      if (subFolder.name.startsWith(".")) continue;

        let folderPageId = this.stateManager.getFolderMapping(subFolder.path);

        if (!folderPageId) {
          // Create the folder page in Notion
          try {
            folderPageId = await this.notionClient.createPage(
              parentNotionId,
              subFolder.name,
              [],
              undefined,
              "\u{1F4C1}" // folder emoji
            );
            this.stateManager.setFolderMapping(subFolder.path, folderPageId);
            await this.persistState();
            this.stateManager.addLog(
              "info",
              `Created folder: ${subFolder.path}`
            );
          } catch (error) {
            this.stateManager.addLog(
              "error",
              `Failed to create folder: ${errMsg(error)}`,
              subFolder.path
            );
            continue;
          }
        } else {
          // Verify the folder page still exists
          const page = await this.notionClient.getPage(folderPageId);
          if (!page || page.archived) {
            // Recreate it
            folderPageId = await this.notionClient.createPage(
              parentNotionId,
              subFolder.name,
              [],
              undefined,
              "\u{1F4C1}"
            );
            this.stateManager.setFolderMapping(subFolder.path, folderPageId);
            await this.persistState();
          }
        }

      // Recurse into subfolder
      await this.syncFolder(subFolder, folderPageId);
    }
  }

  /**
   * Ensure all parent folders for a file exist in Notion.
   */
  private async ensureParentFolders(file: TFile): Promise<void> {
    const parts = file.path.split("/");
    parts.pop(); // Remove filename

    let currentPath = "";
    let parentId = this.settings.rootPageId;

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let folderId = this.stateManager.getFolderMapping(currentPath);
      if (!folderId) {
        folderId = await this.notionClient.createPage(
          parentId,
          part,
          [],
          undefined,
          "\u{1F4C1}"
        );
        this.stateManager.setFolderMapping(currentPath, folderId);
        await this.persistState();
      }
      parentId = folderId;
    }
  }

  /**
   * Get the Notion parent page ID for a file.
   */
  private getParentPageId(file: TFile): string {
    if (!file.parent || file.parent.isRoot()) {
      return this.settings.rootPageId;
    }
    return (
      this.stateManager.getFolderMapping(file.parent.path) ||
      this.settings.rootPageId
    );
  }

  /**
   * Extract frontmatter and sync as Notion page properties.
   */
  private syncMetadata(
    _pageId: string,
    _content: string
  ): void {
    // Frontmatter sync to Notion page properties is not yet implemented
  }

  /**
   * Resolve all internal links across synced files (second pass).
   */
  private async resolveAllLinks(files: TFile[]): Promise<void> {
    this.stateManager.addLog("info", "Resolving internal links...");

    for (const file of files) {
      if (this.abortRequested) break;

      const mapping = this.stateManager.getFileMapping(file.path);
      if (!mapping) continue;

      try {
        const content = await this.app.vault.cachedRead(file);
        const linkMap = this.linkResolver.resolveLinks(content);

        if (linkMap.size > 0) {
          // Re-parse and re-sync with resolved links
          const body = MarkdownParser.stripFrontmatter(content);
          let blocks = this.parser.parse(body);
          blocks = this.linkResolver.resolveBlockLinks(blocks, content);

          if (this.settings.syncAttachments) {
            blocks = await this.attachmentUploader.processBlocks(
              blocks,
              file.path
            );
          }

          await this.notionClient.clearPageContent(mapping.notionPageId);
          if (blocks.length > 0) {
            await this.notionClient.appendBlocks(mapping.notionPageId, blocks);
          }
        }
      } catch (error) {
        this.stateManager.addLog(
          "warn",
          `Link resolution failed: ${errMsg(error)}`,
          file.path
        );
      }
    }
  }

  /**
   * Remove mappings for files that no longer exist in the vault.
   */
  private cleanupDeletedFiles(currentFiles: TFile[]): void {
    const currentPaths = new Set(currentFiles.map((f) => f.path));
    const allMappings = this.stateManager.getAllFileMappings();

    for (const path of Object.keys(allMappings)) {
      if (!currentPaths.has(path)) {
        this.stateManager.removeFileMapping(path);
        this.stateManager.addLog("info", `Removed mapping for deleted: ${path}`);
      }
    }
  }

  /**
   * Validate that required settings are configured.
   */
  private validateSettings(): boolean {
    if (!this.settings.notionToken) {
      new Notice("Please configure your Notion API token in settings");
      return false;
    }
    if (!this.settings.rootPageId) {
      new Notice("Please configure your root Notion page ID in settings");
      return false;
    }
    return true;
  }

  /**
   * Simple content hash using a fast string hashing algorithm.
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return hash.toString(36);
  }

  /** Cleanup resources */
  destroy(): void {
    this.notionClient.destroy();
  }
}
