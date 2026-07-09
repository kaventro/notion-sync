import { App, Modal } from "obsidian";
import type { StateManager } from "../stateManager";

/**
 * Modal that displays the sync log with filtering, clearing, and auto-scroll.
 */
export class SyncLogModal extends Modal {
  private filter: "all" | "info" | "warn" | "error" = "all";

  constructor(app: App, private readonly stateManager: StateManager) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("notion-sync-log-modal");

    const logs = this.stateManager.getLogs();

    // Header
    contentEl.createEl("h2", { text: "Sync log" });

    // Filter bar
    const filterBar = contentEl.createDiv({ cls: "sync-log-filter" });
    this.createFilterButton(filterBar, "All", "all");
    this.createFilterButton(filterBar, "Info", "info");
    this.createFilterButton(filterBar, "Warnings", "warn");
    this.createFilterButton(filterBar, "Errors", "error");

    const clearBtn = filterBar.createEl("button", {
      text: "Clear",
      cls: "sync-log-filter-btn sync-log-clear-btn",
      attr: { "aria-label": "Clear all log entries" },
    });
    clearBtn.addEventListener("click", () => {
      this.stateManager.clearLogs();
      this.onOpen();
    });

    // Log container
    const logContainer = contentEl.createDiv({ cls: "sync-log-entries" });

    this.renderLogs(logContainer, logs);

    // Scroll to bottom
    logContainer.scrollTop = logContainer.scrollHeight;

    // Stats
    const statsEl = contentEl.createDiv({ cls: "sync-log-stats" });

    const infos = logs.filter((l) => l.level === "info").length;
    const warns = logs.filter((l) => l.level === "warn").length;
    const errors = logs.filter((l) => l.level === "error").length;
    statsEl.textContent = `Total: ${logs.length} entries | ${infos} info, ${warns} warnings, ${errors} errors`;
  }

  private createFilterButton(
    container: HTMLElement,
    label: string,
    filter: typeof this.filter
  ): void {
    const btn = container.createEl("button", {
      text: label,
      cls: this.filter === filter
        ? "sync-log-filter-btn sync-log-filter-btn--active"
        : "sync-log-filter-btn",
    });

    btn.addEventListener("click", () => {
      this.filter = filter;
      this.onOpen();
    });
  }

  private renderLogs(container: HTMLElement, logs: ReturnType<StateManager["getLogs"]>): void {
    const filtered =
      this.filter === "all"
        ? logs
        : logs.filter((l) => l.level === this.filter);

    if (filtered.length === 0) {
      container.createEl("p", {
        text: "No log entries.",
        cls: "sync-log-empty",
      });
      return;
    }

    for (const entry of filtered) {
      const row = container.createDiv({ cls: `sync-log-entry sync-log-${entry.level}` });

      const time = new Date(entry.timestamp).toLocaleTimeString();

      row.createSpan({ text: `[${time}] `, cls: "sync-log-time" });
      row.createSpan({ text: `[${entry.level.toUpperCase()}] `, cls: "sync-log-tag" });
      row.createSpan({ text: entry.message });

      if (entry.filePath) {
        row.createSpan({ text: ` (${entry.filePath})`, cls: "sync-log-path" });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
