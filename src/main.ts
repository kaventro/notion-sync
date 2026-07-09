import { Plugin, TFile, Notice, activeDocument, activeWindow } from "obsidian";
import { NotionClient } from "./notionClient";
import { SyncEngine } from "./syncEngine";
import { StateManager } from "./stateManager";
import { NotionSyncSettingTab } from "./ui/settingsTab";
import { SyncLogModal } from "./ui/syncLogModal";
import { HistoryModal } from "./ui/historyModal";
import { SyncPanelView, SYNC_PANEL_VIEW_TYPE } from "./ui/syncPanelView";
import {
  SyncMode,
  DEFAULT_SETTINGS,
  DEFAULT_SYNC_STATE,
} from "./types";
import type { PluginSettings, SyncState, SyncHistory } from "./types";

/** Persisted data shape in data.json */
interface PersistedData {
  settings: PluginSettings;
  syncState: SyncState;
  syncHistory?: SyncHistory;
}

export default class NotionSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  stateManager: StateManager = new StateManager(this);
  private syncEngine!: SyncEngine;
  private scheduledInterval: number | null = null;
  private saveDebounce: number | null = null;
  private onSaveEventRef: ReturnType<typeof this.app.vault.on> | null = null;

  // ── Status Bar ─────────────────────────────────────────────
  private statusBarEl!: HTMLElement;

  // ── File Explorer Indicators ───────────────────────────────
  private dirtyFiles = new Set<string>();

  async onload(): Promise<void> {
    await this.loadState();

    this.syncEngine = new SyncEngine(
      this.app,
      this.settings,
      this.stateManager
    );

    // Status bar
    this.statusBarEl = this.addStatusBarItem();

    // Settings tab
    this.addSettingTab(new NotionSyncSettingTab(this.app, this));

    // Register side panel view
    this.registerView(
      SYNC_PANEL_VIEW_TYPE,
      (leaf) => new SyncPanelView(leaf, this)
    );

    // Ribbon icon — opens the sync panel
    this.addRibbonIcon("upload-cloud", "Notion sync", () => {
      void this.activateSyncPanel();
    });

    // Register commands
    this.addCommand({
      id: "sync-vault",
      name: "Sync entire vault to Notion",
      callback: () => { void this.syncFullVault(); },
    });

    this.addCommand({
      id: "sync-current-file",
      name: "Sync current note to Notion",
      editorCallback: (_editor, ctx) => {
        const file = ctx.file;
        if (file) void this.syncCurrentFile(file);
      },
    });

    this.addCommand({
      id: "sync-incremental",
      name: "Sync changed files to Notion",
      callback: () => { void this.syncIncremental(); },
    });

    this.addCommand({
      id: "rebuild-hierarchy",
      name: "Rebuild Notion hierarchy",
      callback: () => { void this.rebuildHierarchy(); },
    });

    this.addCommand({
      id: "open-sync-log",
      name: "Open sync log",
      callback: () => this.openSyncLog(),
    });

    this.addCommand({
      id: "open-sync-panel",
      name: "Open sync panel",
      callback: () => { void this.activateSyncPanel(); },
    });

    this.addCommand({
      id: "pull-current-file",
      name: "Pull current note from Notion",
      editorCallback: (_editor, ctx) => {
        if (ctx.file) void this.pullCurrentFilePublic();
      },
    });

    this.addCommand({
      id: "pull-all",
      name: "Pull all notes from Notion",
      callback: () => { void this.pullAllPublic(); },
    });

    this.addCommand({
      id: "pull-new-pages",
      name: "Pull new pages from Notion",
      callback: () => { void this.pullNewPagesPublic(); },
    });

    // Configure auto-sync based on mode
    this.configureSyncMode();

    // Track dirty (locally modified) files for explorer indicators
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.dirtyFiles.add(file.path);
          this.refreshExplorerDecorations();
        }
      })
    );

    // Listen for file renames to update mappings
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.stateManager.renamePath(oldPath, file.path);
        // Update dirtyFiles set
        if (this.dirtyFiles.has(oldPath)) {
          this.dirtyFiles.delete(oldPath);
          this.dirtyFiles.add(file.path);
        }
        this.debounceSaveState();
        this.refreshExplorerDecorations();
      })
    );

    // Listen for file deletions to cleanup mappings
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.stateManager.removeFileMapping(file.path);
        this.dirtyFiles.delete(file.path);
        this.debounceSaveState();
        this.refreshExplorerDecorations();
      })
    );

    // Refresh explorer decorations once layout is ready
    this.app.workspace.onLayoutReady(() => this.refreshExplorerDecorations());

    // Initial status bar state
    this.updateStatusBar("idle");
  }

  onunload(): void {
    this.clearScheduledSync();
    this.syncEngine?.destroy();
  }

  // ── Status Bar ─────────────────────────────────────────────

  updateStatusBar(state: "idle" | "syncing" | "error", _detail?: string): void {
    if (!this.statusBarEl) return;

    this.statusBarEl.removeClass("notion-sync-status-error");

    switch (state) {
      case "idle": {
        const lastSync = this.stateManager.lastFullSync;
        if (lastSync > 0) {
          const agoStr = this.formatTimeAgo(lastSync);
          this.statusBarEl.setText(`☁ Synced ${agoStr}`);
        } else {
          this.statusBarEl.setText("☁ ready");
        }
        break;
      }
      case "syncing":
        this.statusBarEl.setText("⟳ syncing...");
        break;
      case "error":
        this.statusBarEl.setText("⚠ sync error");
        this.statusBarEl.addClass("notion-sync-status-error");
        break;
    }
  }

  private formatTimeAgo(timestamp: number): string {
    const diffMs = Date.now() - timestamp;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return "yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  // ── File Explorer Indicators ───────────────────────────────

  private refreshExplorerDecorations(): void {
    const allMappings = this.stateManager.getAllFileMappings();

    activeDocument.querySelectorAll<HTMLElement>(".nav-file-title").forEach((el) => {
      const path = el.getAttribute("data-path");
      if (!path) return;

      const isSynced = path in allMappings;
      const isDirty = this.dirtyFiles.has(path);

      el.removeClass("notion-sync-synced");
      el.removeClass("notion-sync-modified");

      if (isSynced && isDirty) {
        el.addClass("notion-sync-modified");
      } else if (isSynced && !isDirty) {
        el.addClass("notion-sync-synced");
      }
    });
  }

  // ── Get Active Sync Panel ──────────────────────────────────

  getActiveSyncPanel(): SyncPanelView | null {
    const leaves = this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW_TYPE);
    if (leaves.length === 0) return null;
    const view = leaves[0].view;
    if (view instanceof SyncPanelView) return view;
    return null;
  }

  // ── Public Methods (called by UI) ──────────────────────────

  /** Configure sync mode (called by settings tab) */
  configureSyncMode(): void {
    this.clearScheduledSync();

    switch (this.settings.syncMode) {
      case SyncMode.OnSave:
        this.onSaveEventRef = this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            if (this.saveDebounce) activeWindow.clearTimeout(this.saveDebounce);
            this.saveDebounce = activeWindow.setTimeout(() => {
              void this.syncCurrentFile(file);
            }, 2000);
          }
        });
        this.registerEvent(this.onSaveEventRef);
        break;

      case SyncMode.Scheduled:
        this.scheduledInterval = activeWindow.setInterval(
          () => { void this.syncIncremental(); },
          this.settings.scheduledIntervalMinutes * 60 * 1000
        );
        this.registerInterval(this.scheduledInterval);
        break;
    }
  }

  /** Test connection to Notion */
  async testConnection(): Promise<boolean> {
    if (!this.settings.notionToken || !this.settings.rootPageId) {
      new Notice("Please fill in token and root page ID first");
      return false;
    }
    const client = new NotionClient(this.settings.notionToken);
    try {
      const ok = await client.testConnection(this.settings.rootPageId);
      new Notice(ok ? "Connection successful!" : "Connection failed: page not found or not shared with integration.");
      return ok;
    } catch (e) {
      new Notice(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
      console.error("[NotionSync] testConnection error:", e);
      return false;
    } finally {
      client.destroy();
    }
  }

  /** Save settings and state to disk */
  async saveSettings(): Promise<void> {
    this.syncEngine?.updateSettings(this.settings);
    await this.saveState();
  }

  /** Save full state to data.json */
  async saveState(): Promise<void> {
    const data: PersistedData = {
      settings: this.settings,
      syncState: this.stateManager.getState(),
      syncHistory: this.stateManager.getHistoryForPersistence(),
    };
    await this.saveData(data);
    this.stateManager.markClean();
  }

  // ── Public wrappers called by SyncPanelView ────────────────

  async syncFullVaultPublic(): Promise<void> {
    this.updateStatusBar("syncing");
    const panel = this.getActiveSyncPanel();
    panel?.showProgress("Starting...", 0);
    try {
      await this.syncFullVault();
      this.updateStatusBar("idle");
    } catch (e) {
      this.updateStatusBar("error");
      throw e;
    } finally {
      panel?.hideProgress();
    }
  }

  async syncIncrementalPublic(): Promise<void> {
    this.updateStatusBar("syncing");
    const panel = this.getActiveSyncPanel();
    panel?.showProgress("Starting incremental sync...", 0);
    try {
      await this.syncIncremental();
      this.updateStatusBar("idle");
    } catch (e) {
      this.updateStatusBar("error");
      throw e;
    } finally {
      panel?.hideProgress();
    }
  }

  async syncCurrentFilePublic(): Promise<void> {
    this.updateStatusBar("syncing");
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file");
      this.updateStatusBar("idle");
      return;
    }
    try {
      await this.syncCurrentFile(file);
      this.dirtyFiles.delete(file.path);
      this.refreshExplorerDecorations();
      this.updateStatusBar("idle");
    } catch (e) {
      this.updateStatusBar("error");
      throw e;
    }
  }

  async pullCurrentFilePublic(): Promise<void> {
    this.updateStatusBar("syncing");
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file");
      this.updateStatusBar("idle");
      return;
    }
    try {
      const result = await this.syncEngine.pullCurrentFile(file);
      const messages: Record<string, string> = {
        pulled:     `Pulled from Notion: ${file.basename}`,
        no_change:  `Already up to date: ${file.basename}`,
        not_mapped: `Not synced yet — push to Notion first: ${file.basename}`,
      };
      new Notice(messages[result] ?? `Done: ${file.basename}`);
      if (result === "pulled") {
        this.dirtyFiles.delete(file.path);
        this.refreshExplorerDecorations();
      }
      await this.saveState();
      this.updateStatusBar("idle");
    } catch (e) {
      this.updateStatusBar("error");
      throw e;
    }
  }

  async pullAllPublic(): Promise<void> {
    this.updateStatusBar("syncing");
    const panel = this.getActiveSyncPanel();
    panel?.showProgress("Starting pull...", 0);
    this.syncEngine.setProgressCallback((text, pct) => panel?.showProgress(text, pct));
    try {
      await this.syncEngine.pullAll();
      // Clear dirty flags for all synced files
      const allMappings = this.stateManager.getAllFileMappings();
      for (const p of Object.keys(allMappings)) {
        this.dirtyFiles.delete(p);
      }
      this.refreshExplorerDecorations();
      await this.saveState();
      this.updateStatusBar("idle");
    } catch (e) {
      this.updateStatusBar("error");
      throw e;
    } finally {
      this.syncEngine.setProgressCallback(null);
      panel?.hideProgress();
    }
  }

  async pullNewPagesPublic(): Promise<void> {
    this.updateStatusBar("syncing");
    const panel = this.getActiveSyncPanel();
    panel?.showProgress("Starting pull new pages...", 0);
    this.syncEngine.setProgressCallback((text, pct) => panel?.showProgress(text, pct));
    try {
      await this.syncEngine.pullNewPages();
      this.refreshExplorerDecorations();
      await this.saveState();
      this.updateStatusBar("idle");
    } catch (e) {
      this.updateStatusBar("error");
      throw e;
    } finally {
      this.syncEngine.setProgressCallback(null);
      panel?.hideProgress();
    }
  }

  openSyncLogPublic(): void {
    this.openSyncLog();
  }

  /** Open (or reveal) the sync side panel in the right sidebar */
  async activateSyncPanel(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(SYNC_PANEL_VIEW_TYPE);
    if (existing.length > 0) {
      workspace.setActiveLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SYNC_PANEL_VIEW_TYPE, active: true });
      workspace.setActiveLeaf(leaf);
    }
  }

  // ── History & Rollback ─────────────────────────────────────

  async rollbackFile(historyId: string): Promise<void> {
    const entry = this.stateManager.getHistoryEntry(historyId);
    if (!entry?.snapshot) {
      new Notice("No snapshot available");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(entry.filePath);
    if (!(file instanceof TFile)) {
      new Notice("File not found");
      return;
    }
    await this.app.vault.modify(file, entry.snapshot);
    new Notice(`Rolled back: ${entry.fileName}`);
  }

  openHistoryModal(): void {
    new HistoryModal(this.app, this).open();
  }

  // ── Private ────────────────────────────────────────────────

  private async loadState(): Promise<void> {
    const data = await this.loadData() as PersistedData | null;
    if (data) {
      this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
      this.stateManager.setState({
        ...DEFAULT_SYNC_STATE,
        ...data.syncState,
      });
      if (data.syncHistory) {
        this.stateManager.setHistory({
          entries: data.syncHistory.entries || [],
        });
      }
    }
  }

  private async syncFullVault(): Promise<void> {
    this.updateStatusBar("syncing");
    const panel = this.getActiveSyncPanel();
    panel?.showProgress("Starting full sync...", 0);
    this.syncEngine.setProgressCallback((text, pct) => panel?.showProgress(text, pct));
    try {
      await this.syncEngine.syncFullVault();
      // Clear dirty flags for all mapped files
      const allMappings = this.stateManager.getAllFileMappings();
      for (const p of Object.keys(allMappings)) {
        this.dirtyFiles.delete(p);
      }
      this.refreshExplorerDecorations();
      await this.saveState();
      this.updateStatusBar("idle");
    } catch (e) {
      this.updateStatusBar("error");
      throw e;
    } finally {
      this.syncEngine.setProgressCallback(null);
      panel?.hideProgress();
    }
  }

  private async syncIncremental(): Promise<void> {
    this.updateStatusBar("syncing");
    const panel = this.getActiveSyncPanel();
    this.syncEngine.setProgressCallback((text, pct) => panel?.showProgress(text, pct));
    try {
      await this.syncEngine.syncIncremental();
      const allMappings = this.stateManager.getAllFileMappings();
      for (const p of Object.keys(allMappings)) {
        this.dirtyFiles.delete(p);
      }
      this.refreshExplorerDecorations();
      await this.saveState();
      this.updateStatusBar("idle");
    } catch (e) {
      this.updateStatusBar("error");
      throw e;
    } finally {
      this.syncEngine.setProgressCallback(null);
      panel?.hideProgress();
    }
  }

  private async syncCurrentFile(file: TFile): Promise<void> {
    this.updateStatusBar("syncing");
    try {
      await this.syncEngine.syncCurrentFile(file);
      this.dirtyFiles.delete(file.path);
      this.refreshExplorerDecorations();
      await this.saveState();
      this.updateStatusBar("idle");
    } catch (e) {
      this.updateStatusBar("error");
      throw e;
    }
  }

  private async rebuildHierarchy(): Promise<void> {
    await this.syncEngine.rebuildHierarchy();
    await this.saveState();
  }

  private openSyncLog(): void {
    new SyncLogModal(this.app, this.stateManager.getLogs()).open();
  }

  private clearScheduledSync(): void {
    if (this.scheduledInterval !== null) {
      activeWindow.clearInterval(this.scheduledInterval);
      this.scheduledInterval = null;
    }
    if (this.onSaveEventRef !== null) {
      this.app.vault.offref(this.onSaveEventRef);
      this.onSaveEventRef = null;
    }
    if (this.saveDebounce !== null) {
      activeWindow.clearTimeout(this.saveDebounce);
      this.saveDebounce = null;
    }
  }

  private debounceSaveState(): void {
    if (this.saveDebounce) activeWindow.clearTimeout(this.saveDebounce);
    this.saveDebounce = activeWindow.setTimeout(() => { void this.saveState(); }, 1000);
  }
}
