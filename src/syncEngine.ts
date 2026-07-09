import type { App, TFile } from "obsidian";
import { Notice } from "obsidian";
import { NotionClient } from "./notionClient";
import { MarkdownParser } from "./markdownParser";
import { NotionToMarkdown } from "./notionToMarkdown";
import { LinkResolver } from "./linkResolver";
import { AttachmentUploader } from "./attachmentUploader";
import type { StateManager } from "./stateManager";
import type { PluginSettings } from "./types";
import type {
  ImportResult,
  PullFileResult,
  PullResult,
  SyncResult,
} from "./sync/contracts";
import { SyncControl } from "./sync/syncControl";
import { ProgressReporter, type ProgressCallback } from "./sync/progressReporter";
import { StatePersister, type PersistCallback } from "./sync/statePersister";
import { ChangeScanner, type PendingChange } from "./sync/changeScanner";
import { WikiLinkRestorer } from "./sync/wikiLinkRestorer";
import { VaultFileNamer } from "./sync/vaultFileNamer";
import { ImageDownloader } from "./sync/imageDownloader";
import { FolderHierarchySyncer } from "./sync/folderHierarchySyncer";
import { PushService } from "./sync/pushService";
import { PullService } from "./sync/pullService";
import { NotionTreeImporter } from "./sync/notionTreeImporter";

/**
 * Facade and composition root for vault ⇄ Notion synchronization.
 *
 * Wires the sync services together and guards every entry point with a
 * single run lock (SyncControl) and settings validation, while the
 * services contain the actual sync logic:
 *  - PushService          vault → Notion (full / incremental / single file)
 *  - PullService          Notion → vault for already-mapped files
 *  - NotionTreeImporter   creates local files for unmapped Notion pages
 *  - FolderHierarchySyncer mirrors the folder tree as Notion pages
 */
export class SyncEngine {
  private settings: PluginSettings;
  private readonly stateManager: StateManager;
  private readonly notionClient: NotionClient;
  private readonly attachmentUploader: AttachmentUploader;

  private readonly control = new SyncControl();
  private readonly progress = new ProgressReporter();
  private readonly persister: StatePersister;

  private readonly push: PushService;
  private readonly pull: PullService;
  private readonly importer: NotionTreeImporter;
  private readonly changeScanner: ChangeScanner;

  constructor(app: App, settings: PluginSettings, stateManager: StateManager) {
    this.settings = settings;
    this.stateManager = stateManager;

    this.notionClient = new NotionClient(settings.notionToken);
    this.persister = new StatePersister(stateManager);
    this.changeScanner = new ChangeScanner(app, stateManager);
    this.attachmentUploader = new AttachmentUploader(
      app,
      stateManager,
      settings.attachmentUploadUrl
    );

    const settingsProvider = (): PluginSettings => this.settings;
    const namer = new VaultFileNamer(app);
    const wikiLinks = new WikiLinkRestorer(stateManager);
    const n2md = new NotionToMarkdown();
    const images = new ImageDownloader({
      app,
      stateManager,
      namer,
      settings: settingsProvider,
    });
    const folders = new FolderHierarchySyncer({
      app,
      notion: this.notionClient,
      stateManager,
      persister: this.persister,
      settings: settingsProvider,
      control: this.control,
    });

    this.push = new PushService({
      app,
      notion: this.notionClient,
      stateManager,
      parser: new MarkdownParser(),
      linkResolver: new LinkResolver(app, stateManager),
      attachments: this.attachmentUploader,
      folders,
      progress: this.progress,
      persister: this.persister,
      settings: settingsProvider,
      control: this.control,
    });

    this.pull = new PullService({
      app,
      notion: this.notionClient,
      stateManager,
      n2md,
      wikiLinks,
      images,
      progress: this.progress,
      control: this.control,
    });

    this.importer = new NotionTreeImporter({
      app,
      notion: this.notionClient,
      stateManager,
      n2md,
      wikiLinks,
      images,
      namer,
      progress: this.progress,
      persister: this.persister,
      settings: settingsProvider,
      control: this.control,
    });
  }

  // ── Configuration ──────────────────────────────────────────

  /** Update references when settings change */
  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
    this.notionClient.updateToken(settings.notionToken);
    this.attachmentUploader.setUploadUrl(settings.attachmentUploadUrl);
  }

  setProgressCallback(cb: ProgressCallback | null): void {
    this.progress.set(cb);
  }

  setPersistCallback(cb: PersistCallback | null): void {
    this.persister.set(cb);
  }

  /** Whether a sync is currently in progress */
  get syncing(): boolean {
    return this.control.isSyncing;
  }

  /** Request abort of current sync */
  abort(): void {
    this.control.abort();
  }

  // ── Push ───────────────────────────────────────────────────

  /** Sync the entire vault to Notion. */
  async syncFullVault(): Promise<SyncResult> {
    return this.runExclusive({ synced: 0, errors: 0 }, () => this.push.fullVault());
  }

  /** Only sync files that have changed since last sync. */
  async syncIncremental(): Promise<SyncResult> {
    return this.runExclusive({ synced: 0, errors: 0 }, () => this.push.incremental());
  }

  /** Sync a single file to Notion. */
  async syncCurrentFile(file: TFile): Promise<boolean> {
    return this.runExclusive(false, () => this.push.currentFile(file));
  }

  /**
   * Completely rebuild the Notion page hierarchy from scratch.
   * Clears all existing mappings and recreates everything.
   */
  async rebuildHierarchy(): Promise<void> {
    await this.runExclusive(undefined, async () => {
      this.stateManager.addLog("info", "Rebuilding Notion hierarchy");
      new Notice("Rebuilding hierarchy... This may take a while.");

      this.stateManager.reset();
      await this.push.fullVault();
    });
  }

  // ── Pull ───────────────────────────────────────────────────

  /**
   * Pull a single file from Notion → always overwrites the local file.
   * No conflict detection — Notion is the source of truth when pulling.
   */
  async pullCurrentFile(file: TFile): Promise<PullFileResult> {
    if (!this.validateSettings()) return "not_mapped";
    return this.pull.pullFile(file);
  }

  /** Pull all mapped files from Notion — always overwrites local files. */
  async pullAll(): Promise<PullResult> {
    return this.runExclusive({ pulled: 0, skipped: 0, errors: 0 }, () =>
      this.pull.pullAll()
    );
  }

  /** Create local files for Notion pages not yet mapped to the vault. */
  async pullNewPages(): Promise<ImportResult> {
    return this.runExclusive({ created: 0, errors: 0 }, () =>
      this.importer.importNewPages()
    );
  }

  // ── Status ─────────────────────────────────────────────────

  /** List local files a push would send to Notion (like `git status`). */
  async scanPendingChanges(): Promise<PendingChange[]> {
    return this.changeScanner.scan();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /** Cleanup resources */
  destroy(): void {
    this.notionClient.destroy();
  }

  // ── Internal ───────────────────────────────────────────────

  /**
   * Run an operation under the single-run lock with validated settings.
   * Returns `busyResult` when another sync is active or settings are
   * incomplete.
   */
  private async runExclusive<T>(busyResult: T, op: () => Promise<T>): Promise<T> {
    if (!this.validateSettings()) return busyResult;

    if (!this.control.begin()) {
      new Notice("Sync already in progress");
      return busyResult;
    }
    try {
      return await op();
    } finally {
      this.control.end();
    }
  }

  /** Validate that required settings are configured. */
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
}
