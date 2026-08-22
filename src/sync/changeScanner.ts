import type { App } from "obsidian";
import type { StateManager } from "../stateManager";
import { hashContent } from "../utils";

export type ChangeStatus = "new" | "modified" | "renamed";

export interface PendingChange {
  path: string;
  name: string;
  status: ChangeStatus;
}

/**
 * Computes which vault files have local changes that a push would send
 * to Notion — unmapped files ("new"), mapped files whose content changed
 * since the last sync ("modified"), and mapped files renamed since then
 * ("renamed"). Mirrors `git status` for the sync panel.
 */
export class ChangeScanner {
  constructor(
    private readonly app: App,
    private readonly stateManager: StateManager
  ) {}

  async scan(): Promise<PendingChange[]> {
    const changes: PendingChange[] = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      const mapping = this.stateManager.getFileMapping(file.path);

      if (!mapping) {
        changes.push({ path: file.path, name: file.basename, status: "new" });
        continue;
      }

      // A rename leaves content (and mtime, on most platforms) untouched,
      // so the Notion page title is stale even if nothing else changed.
      const renamed =
        mapping.lastSyncedTitle !== undefined &&
        mapping.lastSyncedTitle !== file.basename;

      // Cheap pre-filter: skip files untouched since the last sync.
      if (!renamed && file.stat.mtime <= mapping.lastSyncedAt) continue;

      // mtime moved — confirm with a content hash to avoid false positives
      // from saves that didn't change the bytes.
      const content = await this.app.vault.cachedRead(file);
      if (hashContent(content) !== mapping.lastSyncedHash) {
        changes.push({ path: file.path, name: file.basename, status: "modified" });
      } else if (renamed) {
        changes.push({ path: file.path, name: file.basename, status: "renamed" });
      }
    }

    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }
}
