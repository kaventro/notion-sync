import { ItemView, WorkspaceLeaf, activeWindow, setIcon } from "obsidian";
import type NotionSyncPlugin from "../main";
import { SyncMode } from "../types";

export const SYNC_PANEL_VIEW_TYPE = "notion-sync-panel";

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

  constructor(leaf: WorkspaceLeaf, plugin: NotionSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
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
    this.refreshInterval = activeWindow.setInterval(() => this.refreshStatus(), 30_000);
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    if (this.refreshInterval !== null) {
      activeWindow.clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    return Promise.resolve();
  }

  /** Full re-render (called on open or mode change) */
  render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("notion-sync-panel");

    // ── Header action bar (mimics VS Code SCM toolbar) ─────────
    const toolbar = root.createDiv({ cls: "notion-sync-toolbar" });

    // Push group
    const pushGroup = toolbar.createDiv({ cls: "notion-sync-toolbar-group" });
    this.addToolbarBtn(pushGroup, "upload-cloud", "Push: Sync entire vault to Notion", () => {
      void this.runAction(() => this.plugin.syncFullVaultPublic());
    });
    this.addToolbarBtn(pushGroup, "refresh-cw", "Push: Sync changed files to Notion", () => {
      void this.runAction(() => this.plugin.syncIncrementalPublic());
    });
    this.addToolbarBtn(pushGroup, "file-up", "Push: Sync current note to Notion", () => {
      void this.runAction(() => this.plugin.syncCurrentFilePublic());
    });

    // Divider
    toolbar.createDiv({ cls: "notion-sync-toolbar-divider" });

    // Pull group
    const pullGroup = toolbar.createDiv({ cls: "notion-sync-toolbar-group" });
    this.addToolbarBtn(pullGroup, "download-cloud", "Pull: All notes from Notion", () => {
      void this.runAction(() => this.plugin.pullAllPublic());
    });
    this.addToolbarBtn(pullGroup, "file-down", "Pull: Current note from Notion", () => {
      void this.runAction(() => this.plugin.pullCurrentFilePublic());
    });
    this.addToolbarBtn(pullGroup, "folder-down", "Pull new pages from Notion", () => {
      void this.runAction(() => this.plugin.pullNewPagesPublic());
    });

    // Divider
    toolbar.createDiv({ cls: "notion-sync-toolbar-divider" });

    this.addToolbarBtn(toolbar, "history", "Sync history", () =>
      this.plugin.openHistoryModal()
    );

    this.addToolbarBtn(toolbar, "list", "Open sync log", () =>
      this.plugin.openSyncLogPublic()
    );

    // ── Progress bar ───────────────────────────────────────────
    this.progressEl = root.createDiv({ cls: "notion-sync-progress notion-sync-progress-hidden" });

    const progressBar = this.progressEl.createDiv({ cls: "notion-sync-progress-bar" });
    this.progressFillEl = progressBar.createDiv({ cls: "notion-sync-progress-fill" });
    this.progressTextEl = this.progressEl.createDiv({ cls: "notion-sync-progress-text" });

    // ── Mode selector ──────────────────────────────────────────
    const modeSection = root.createDiv({ cls: "notion-sync-section" });
    modeSection.createEl("p", { text: "Auto sync", cls: "notion-sync-section-title" });

    const modeRow = modeSection.createDiv({ cls: "notion-sync-mode-row" });

    const modeSelect = modeRow.createEl("select", { cls: "notion-sync-select" });
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
      const intervalRow = modeSection.createDiv({ cls: "notion-sync-interval-row" });
      intervalRow.createSpan({ text: "Every" });

      const intervalSelect = intervalRow.createEl("select", { cls: "notion-sync-select" });
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

    // ── Status ─────────────────────────────────────────────────
    const statusSection = root.createDiv({ cls: "notion-sync-section" });
    statusSection.createEl("p", { text: "Status", cls: "notion-sync-section-title" });
    this.statusEl = statusSection.createDiv({ cls: "notion-sync-status-block" });
    this.refreshStatus();
  }

  /** Update just the status block without full re-render */
  refreshStatus(): void {
    if (!this.statusEl) return;
    this.statusEl.empty();

    const sm = this.plugin.stateManager;
    this.statusEl.createEl("p", { text: `Files synced: ${sm.syncedFileCount}` });
    this.statusEl.createEl("p", { text: `Folders synced: ${sm.syncedFolderCount}` });

    const last = sm.lastFullSync;
    this.statusEl.createEl("p", {
      text: last > 0
        ? `Last full sync: ${new Date(last).toLocaleString()}`
        : "No full sync yet",
    });

    const mode = this.plugin.settings.syncMode;
    const modeLabel: Record<SyncMode, string> = {
      [SyncMode.Manual]: "Manual",
      [SyncMode.CurrentFile]: "Current file",
      [SyncMode.OnSave]: "On save",
      [SyncMode.Scheduled]: `Every ${this.plugin.settings.scheduledIntervalMinutes} min`,
    };
    this.statusEl.createEl("p", {
      text: `Mode: ${modeLabel[mode] ?? mode}`,
      cls: "notion-sync-mode-label",
    });
  }

  /** Show a progress bar with text and percentage */
  showProgress(text: string, percent: number): void {
    if (!this.progressEl || !this.progressFillEl || !this.progressTextEl) return;
    this.progressEl.removeClass("notion-sync-progress-hidden");
    this.progressFillEl.setCssProps({ "--fill-width": `${Math.max(0, Math.min(100, percent))}%` });
    this.progressTextEl.setText(text);
  }

  /** Hide the progress bar */
  hideProgress(): void {
    if (!this.progressEl) return;
    this.progressEl.addClass("notion-sync-progress-hidden");
    if (this.progressFillEl) this.progressFillEl.setCssProps({ "--fill-width": "0%" });
    if (this.progressTextEl) this.progressTextEl.setText("");
  }

  // ── Helpers ────────────────────────────────────────────────

  private addToolbarBtn(
    container: HTMLElement,
    iconName: string,
    tooltip: string,
    onClick: () => void
  ): HTMLElement {
    const btn = container.createEl("button", {
      cls: "notion-sync-toolbar-btn clickable-icon",
      attr: { "aria-label": tooltip },
    });
    setIcon(btn, iconName);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      this.refreshStatus();
    } catch (e) {
      console.error("[NotionSync] panel action error:", e);
    }
  }
}
