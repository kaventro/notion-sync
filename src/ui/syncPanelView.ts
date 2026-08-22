import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type NotionSyncPlugin from "../main";
import { SyncMode } from "../types";
import { ChangesList } from "./changesList";

export const SYNC_PANEL_VIEW_TYPE = "notion-vault-sync-panel";

/**
 * Side panel view for Notion Sync — similar to VS Code's Source Control panel.
 * Shows sync controls and status at the top of the right sidebar.
 */
export class SyncPanelView extends ItemView {
  private plugin: NotionSyncPlugin;
  private statusEl: HTMLElement | null = null;
  private refreshInterval: number | null = null;
  private progressEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private progressTextEl: HTMLElement | null = null;

  // New UI Elements
  private badgeEl: HTMLElement | null = null;
  private filesCountEl: HTMLElement | null = null;
  private foldersCountEl: HTMLElement | null = null;
  private lastSyncEl: HTMLElement | null = null;
  private changesRefreshDebounce: number | null = null;
  private isSyncing = false;
  private hasError = false;
  private readonly changesList: ChangesList;

  constructor(leaf: WorkspaceLeaf, plugin: NotionSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.changesList = new ChangesList({
      scan: () => this.plugin.scanPendingChanges(),
      onOpenFile: (path) => { void this.openFile(path); },
      onPushFile: (path) => this.pushSingleChange(path),
    });
  }

  getViewType(): string {
    return SYNC_PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Notion sync";
  }

  getIcon(): string {
    return "upload-cloud";
  }

  onOpen(): Promise<void> {
    this.render();
    // Refresh status every 30s
    this.refreshInterval = window.setInterval(() => this.refreshStatus(), 30_000);

    // Keep the changes list in step with vault edits (debounced)
    const scheduleChangesRefresh = (): void => {
      if (this.changesRefreshDebounce) window.clearTimeout(this.changesRefreshDebounce);
      this.changesRefreshDebounce = window.setTimeout(() => {
        this.changesRefreshDebounce = null;
        void this.refreshChanges();
      }, 800);
    };
    this.registerEvent(this.app.vault.on("modify", scheduleChangesRefresh));
    this.registerEvent(this.app.vault.on("create", scheduleChangesRefresh));
    this.registerEvent(this.app.vault.on("delete", scheduleChangesRefresh));
    this.registerEvent(this.app.vault.on("rename", scheduleChangesRefresh));
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    if (this.refreshInterval !== null) {
      window.clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    if (this.changesRefreshDebounce !== null) {
      window.clearTimeout(this.changesRefreshDebounce);
      this.changesRefreshDebounce = null;
    }
    return Promise.resolve();
  }

  /** Full re-render (called on open or mode change) */
  render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("notion-vault-sync-panel");

    // ── Header & Status Brand ────────────────────────────────
    const header = root.createDiv({ cls: "notion-vault-sync-header" });
    const brand = header.createDiv({ cls: "notion-vault-sync-brand" });
    brand.createEl("h3", { text: "Notion vault sync" });
    this.badgeEl = header.createDiv();
    this.updateStatusBadge();

    // ── Actions Card ──────────────────────────────────────────
    const actionsCard = root.createDiv({ cls: "notion-vault-sync-actions-card" });

    // Primary Action (Push Vault)
    const pushBtn = actionsCard.createEl("button", {
      cls: "notion-vault-sync-btn-primary",
      attr: { "aria-label": "Push: sync entire vault to Notion" }
    });
    setIcon(pushBtn, "upload-cloud");
    pushBtn.createSpan({ text: "Push vault to Notion" });
    pushBtn.addEventListener("click", () => {
      void this.runAction(() => this.plugin.syncFullVaultPublic());
    });

    // Action Grid for quick actions
    const grid = actionsCard.createDiv({ cls: "notion-vault-sync-action-grid" });

    this.addGridBtn(grid, "refresh-cw", "Sync Changed", "Push: Sync changed files to Notion", () => {
      void this.runAction(() => this.plugin.syncIncrementalPublic());
    });

    this.addGridBtn(grid, "file-up", "Push Note", "Push: Sync current note to Notion", () => {
      void this.runAction(() => this.plugin.syncCurrentFilePublic());
    });

    this.addGridBtn(grid, "download-cloud", "Pull All", "Pull: All notes from Notion", () => {
      void this.runAction(() => this.plugin.pullAllPublic());
    });

    this.addGridBtn(grid, "folder-down", "Pull New", "Pull new pages from Notion", () => {
      void this.runAction(() => this.plugin.pullNewPagesPublic());
    });

    // ── Progress bar ───────────────────────────────────────────
    this.progressEl = root.createDiv({ cls: "notion-vault-sync-progress notion-vault-sync-progress-hidden" });

    const progressBar = this.progressEl.createDiv({ cls: "notion-vault-sync-progress-bar" });
    this.progressFillEl = progressBar.createDiv({ cls: "notion-vault-sync-progress-fill" });
    this.progressTextEl = this.progressEl.createDiv({ cls: "notion-vault-sync-progress-text" });

    // ── Changes (files a push would send, like git status) ────
    this.changesList.mount(root);

    // ── Stats Cards ────────────────────────────────────────────
    const statsContainer = root.createDiv({ cls: "notion-vault-sync-stats-container" });

    const filesCard = statsContainer.createDiv({ cls: "notion-vault-sync-stat-card" });
    this.filesCountEl = filesCard.createDiv({ cls: "notion-vault-sync-stat-val" });
    filesCard.createDiv({ cls: "notion-vault-sync-stat-lbl", text: "Files" });

    const foldersCard = statsContainer.createDiv({ cls: "notion-vault-sync-stat-card" });
    this.foldersCountEl = foldersCard.createDiv({ cls: "notion-vault-sync-stat-val" });
    foldersCard.createDiv({ cls: "notion-vault-sync-stat-lbl", text: "Folders" });

    // ── Mode selector card ─────────────────────────────────────
    const modeCard = root.createDiv({ cls: "notion-vault-sync-card-section" });
    modeCard.createEl("p", { text: "Auto sync mode", cls: "notion-vault-sync-card-section-title" });

    const selectWrapper = modeCard.createDiv({ cls: "notion-vault-sync-select-wrapper" });
    const modeSelect = selectWrapper.createEl("select", { cls: "notion-vault-sync-select" });
    const options: [SyncMode, string][] = [
      [SyncMode.Manual, "Manual"],
      [SyncMode.OnSave, "On save"],
      [SyncMode.Scheduled, "Scheduled"],
    ];
    for (const [value, label] of options) {
      const opt = modeSelect.createEl("option", { text: label, value });
      if (this.plugin.settings.syncMode === value) opt.selected = true;
    }

    modeSelect.addEventListener("change", () => {
      void (async () => {
        this.plugin.settings.syncMode = modeSelect.value as SyncMode;
        await this.plugin.saveSettings();
        this.plugin.configureSyncMode();
        this.render();
      })();
    });

    // Interval picker (only visible in Scheduled mode)
    if (this.plugin.settings.syncMode === SyncMode.Scheduled) {
      const intervalRow = modeCard.createDiv({ cls: "notion-vault-sync-mode-row" });
      intervalRow.createSpan({ text: "Every", cls: "notion-vault-sync-interval-label" });

      const intervalSelect = intervalRow.createEl("select", { cls: "notion-vault-sync-select" });
      for (const mins of [5, 10, 15, 30, 60]) {
        const opt = intervalSelect.createEl("option", { text: `${mins} min`, value: String(mins) });
        if (this.plugin.settings.scheduledIntervalMinutes === mins) opt.selected = true;
      }

      intervalSelect.addEventListener("change", () => {
        void (async () => {
          this.plugin.settings.scheduledIntervalMinutes = Number(intervalSelect.value);
          await this.plugin.saveSettings();
          this.plugin.configureSyncMode();
        })();
      });
    }

    // Last Sync status
    this.lastSyncEl = modeCard.createDiv({ cls: "notion-vault-sync-last-sync-block" });

    // ── Footer Utilities ───────────────────────────────────────
    const footer = root.createDiv({ cls: "notion-vault-sync-footer" });

    const historyBtn = footer.createEl("button", {
      cls: "notion-vault-sync-footer-btn",
    });
    setIcon(historyBtn, "history");
    historyBtn.createSpan({ text: "History" });
    historyBtn.addEventListener("click", () => this.plugin.openHistoryModal());

    const logBtn = footer.createEl("button", {
      cls: "notion-vault-sync-footer-btn",
    });
    setIcon(logBtn, "list");
    logBtn.createSpan({ text: "Logs" });
    logBtn.addEventListener("click", () => this.plugin.openSyncLogPublic());

    this.refreshStatus();
  }

  /** Update just the status block without full re-render */
  refreshStatus(): void {
    const sm = this.plugin.stateManager;
    void this.refreshChanges();

    if (this.filesCountEl) {
      this.filesCountEl.setText(String(sm.syncedFileCount));
    }
    if (this.foldersCountEl) {
      this.foldersCountEl.setText(String(sm.syncedFolderCount));
    }

    if (this.lastSyncEl) {
      this.lastSyncEl.empty();
      setIcon(this.lastSyncEl, "clock");
      const last = sm.lastFullSync;
      this.lastSyncEl.createSpan({
        text: last > 0
          ? `Last sync: ${new Date(last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : "Never synced",
      });
    }
  }

  /** Rebuild the pending-changes list (like git status) */
  async refreshChanges(): Promise<void> {
    await this.changesList.refresh();
  }

  private async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  private async pushSingleChange(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.runAction(() => this.plugin.pushFile(file));
  }

  private updateStatusBadge(): void {
    if (!this.badgeEl) return;
    this.badgeEl.empty();

    let statusClass = "status-connected";
    let statusText = "Ready";

    if (this.hasError) {
      statusClass = "status-error";
      statusText = "Error";
    } else if (this.isSyncing) {
      statusClass = "status-syncing";
      statusText = "Syncing";
    }

    this.badgeEl.className = `notion-vault-sync-status-badge ${statusClass}`;
    this.badgeEl.createDiv({ cls: "notion-vault-sync-pulsing-dot" });
    this.badgeEl.createSpan({ text: statusText });
  }

  /** Show a progress bar with text and percentage */
  showProgress(text: string, percent: number): void {
    this.isSyncing = true;
    this.hasError = false;
    this.updateStatusBadge();

    if (!this.progressEl || !this.progressFillEl || !this.progressTextEl) return;
    this.progressEl.removeClass("notion-vault-sync-progress-hidden");
    this.progressFillEl.setCssProps({ "--fill-width": `${Math.max(0, Math.min(100, percent))}%` });
    
    // Split the text to show progress details elegantly
    this.progressTextEl.empty();
    this.progressTextEl.createSpan({ text });
    this.progressTextEl.createSpan({ text: `${Math.round(percent)}%` });
  }

  /** Hide the progress bar */
  hideProgress(): void {
    this.isSyncing = false;
    this.updateStatusBadge();

    if (!this.progressEl) return;
    this.progressEl.addClass("notion-vault-sync-progress-hidden");
    if (this.progressFillEl) this.progressFillEl.setCssProps({ "--fill-width": "0%" });
    if (this.progressTextEl) this.progressTextEl.setText("");
  }

  // ── Helpers ────────────────────────────────────────────────

  private addGridBtn(
    container: HTMLElement,
    iconName: string,
    label: string,
    tooltip: string,
    onClick: () => void
  ): HTMLElement {
    const btn = container.createEl("button", {
      cls: "notion-vault-sync-grid-btn",
      attr: { "aria-label": tooltip },
    });
    setIcon(btn, iconName);
    btn.createSpan({ text: label });
    btn.addEventListener("click", onClick);
    return btn;
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    try {
      this.isSyncing = true;
      this.hasError = false;
      this.updateStatusBadge();
      await action();
      this.isSyncing = false;
      this.updateStatusBadge();
      this.refreshStatus();
    } catch (e) {
      this.isSyncing = false;
      this.hasError = true;
      this.updateStatusBadge();
      console.error("[NotionSync] panel action error:", e);
    }
  }
}
