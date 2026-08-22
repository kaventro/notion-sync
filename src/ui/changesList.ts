import { setIcon } from "obsidian";
import type { PendingChange } from "../sync/changeScanner";

export interface ChangesListCallbacks {
  /** Compute the current pending changes. */
  scan: () => Promise<PendingChange[]>;
  /** Open a vault file in the workspace. */
  onOpenFile: (path: string) => void;
  /** Push a single file to Notion. */
  onPushFile: (path: string) => Promise<void>;
}

/** Single-letter badge shown for each pending change, git-status style. */
const STATUS_MARKS: Record<PendingChange["status"], { text: string; label: string }> = {
  new: { text: "U", label: "Not synced yet" },
  modified: { text: "M", label: "Modified since last sync" },
  renamed: { text: "R", label: "Renamed since last sync" },
};

/**
 * Renders the "Changes" card of the sync panel: a git-status-like list
 * of files a push would send, with per-file open and push actions.
 */
export class ChangesList {
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;

  constructor(private readonly callbacks: ChangesListCallbacks) {}

  /** Create the card inside the given parent and do an initial refresh. */
  mount(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "notion-vault-sync-card-section notion-vault-sync-changes-card" });
    const header = card.createDiv({ cls: "notion-vault-sync-changes-header" });
    header.createEl("p", { text: "Changes", cls: "notion-vault-sync-card-section-title" });
    this.countEl = header.createSpan({ cls: "notion-vault-sync-changes-count", text: "0" });
    this.listEl = card.createDiv({ cls: "notion-vault-sync-changes-list" });
    void this.refresh();
  }

  /** Rebuild the list from a fresh scan. */
  async refresh(): Promise<void> {
    const listEl = this.listEl;
    const countEl = this.countEl;
    if (!listEl || !countEl) return;

    const changes = await this.callbacks.scan();
    countEl.setText(String(changes.length));

    listEl.empty();
    if (changes.length === 0) {
      listEl.createDiv({ cls: "notion-vault-sync-changes-empty", text: "Everything is synced" });
      return;
    }

    for (const change of changes) {
      this.renderRow(listEl, change);
    }
  }

  private renderRow(listEl: HTMLElement, change: PendingChange): void {
    const row = listEl.createDiv({ cls: "notion-vault-sync-change-row" });

    const mark = STATUS_MARKS[change.status];

    row.createSpan({
      cls: `notion-vault-sync-change-status is-${change.status}`,
      text: mark.text,
      attr: { "aria-label": mark.label },
    });

    row.createSpan({
      cls: "notion-vault-sync-change-name",
      text: change.name,
      attr: { "aria-label": change.path },
    });

    row.addEventListener("click", () => {
      this.callbacks.onOpenFile(change.path);
    });

    const pushBtn = row.createEl("button", {
      cls: "notion-vault-sync-change-push",
      attr: { "aria-label": `Push ${change.name} to Notion` },
    });
    setIcon(pushBtn, "upload");
    pushBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.callbacks.onPushFile(change.path).then(() => this.refresh());
    });
  }
}
