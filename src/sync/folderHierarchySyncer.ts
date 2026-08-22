import type { App, TFile } from "obsidian";
import { TFolder } from "obsidian";
import type { StateManager } from "../stateManager";
import type { NotionApi, SettingsProvider } from "./contracts";
import type { StatePersister } from "./statePersister";
import type { SyncControl } from "./syncControl";
import { errMsg } from "../utils";

const FOLDER_EMOJI = "\u{1F4C1}";

export interface FolderHierarchySyncerDeps {
  app: App;
  notion: NotionApi;
  stateManager: StateManager;
  persister: StatePersister;
  settings: SettingsProvider;
  control: SyncControl;
}

/**
 * Mirrors the vault's folder tree as nested Notion pages and resolves
 * which Notion page a given file should be created under.
 */
export class FolderHierarchySyncer {
  constructor(private readonly deps: FolderHierarchySyncerDeps) {}

  /** Create the Notion page hierarchy mirroring the vault's folder structure. */
  async syncAll(): Promise<void> {
    const rootFolder = this.deps.app.vault.getRoot();
    await this.syncFolder(rootFolder, this.deps.settings().rootPageId);
  }

  /** Ensure all parent folders for a file exist in Notion. */
  async ensureParentFolders(file: TFile): Promise<void> {
    const parts = file.path.split("/");
    parts.pop(); // Remove filename

    let currentPath = "";
    let parentId = this.deps.settings().rootPageId;

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let folderId = this.deps.stateManager.getFolderMapping(currentPath);
      if (!folderId) {
        folderId = await this.deps.notion.createPage(
          parentId,
          part,
          [],
          undefined,
          FOLDER_EMOJI
        );
        this.deps.stateManager.setFolderMapping(currentPath, folderId);
        await this.deps.persister.persist();
      }
      parentId = folderId;
    }
  }

  /** Get the Notion parent page ID for a file. */
  getParentPageId(file: TFile): string {
    if (!file.parent || file.parent.isRoot()) {
      return this.deps.settings().rootPageId;
    }
    return (
      this.deps.stateManager.getFolderMapping(file.parent.path) ||
      this.deps.settings().rootPageId
    );
  }

  private async syncFolder(folder: TFolder, parentNotionId: string): Promise<void> {
    for (const child of folder.children) {
      if (this.deps.control.aborted) return;

      if (!(child instanceof TFolder)) continue;

      const subFolder = child;

      // Skip hidden folders
      if (subFolder.name.startsWith(".")) continue;

      let folderPageId = this.deps.stateManager.getFolderMapping(subFolder.path);

      if (!folderPageId) {
        // Create the folder page in Notion
        try {
          folderPageId = await this.deps.notion.createPage(
            parentNotionId,
            subFolder.name,
            [],
            undefined,
            FOLDER_EMOJI
          );
          this.deps.stateManager.setFolderMapping(subFolder.path, folderPageId);
          await this.deps.persister.persist();
          this.deps.stateManager.addLog("info", `Created folder: ${subFolder.path}`);
        } catch (error) {
          this.deps.stateManager.addLog(
            "error",
            `Failed to create folder: ${errMsg(error)}`,
            subFolder.path
          );
          continue;
        }
      } else {
        // Verify the folder page still exists
        const page = await this.deps.notion.getPage(folderPageId);
        if (!page || page.archived) {
          // Recreate it
          folderPageId = await this.deps.notion.createPage(
            parentNotionId,
            subFolder.name,
            [],
            undefined,
            FOLDER_EMOJI
          );
          this.deps.stateManager.setFolderMapping(subFolder.path, folderPageId);
          await this.deps.persister.persist();
        } else if (this.deps.notion.getPageTitle(page) !== subFolder.name) {
          // Folder renamed in the vault — rename its Notion page too.
          // The page object is already in hand, so this costs no extra read.
          await this.deps.notion.updatePageTitle(folderPageId, subFolder.name);
          this.deps.stateManager.addLog(
            "info",
            `Renamed folder in Notion: ${subFolder.path}`
          );
        }
      }

      // Recurse into subfolder
      await this.syncFolder(subFolder, folderPageId);
    }
  }
}
