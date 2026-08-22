import type { Plugin } from "obsidian";
import type {
  SyncState,
  SyncMapping,
  SyncLogEntry,
  SyncHistoryEntry,
  SyncHistory,
} from "./types";
import {
  createDefaultSyncState,
  createDefaultSyncHistory,
} from "./types";

/**
 * Manages persistent plugin state: file/folder mappings, sync timestamps,
 * and the sync log. All state is stored in data.json via the Obsidian API.
 */
export class StateManager {
  private plugin: Plugin;
  private state: SyncState;
  private log: SyncLogEntry[] = [];
  private maxLogEntries = 500;
  private dirty = false;
  private history: SyncHistory = createDefaultSyncHistory();

  constructor(plugin: Plugin, initialState?: SyncState) {
    this.plugin = plugin;
    this.state = initialState || createDefaultSyncState();
  }

  // ── File Mappings ──────────────────────────────────────────

  /** Get the Notion page ID for an Obsidian file path */
  getFileMapping(filePath: string): SyncMapping | undefined {
    return this.state.fileMappings[filePath];
  }

  /** Store or update the mapping for a file */
  setFileMapping(filePath: string, mapping: SyncMapping): void {
    this.state.fileMappings[filePath] = mapping;
    this.dirty = true;
  }

  /** Remove a file mapping (e.g. after file deletion) */
  removeFileMapping(filePath: string): void {
    delete this.state.fileMappings[filePath];
    this.dirty = true;
  }

  /** Check if a file has been synced before */
  hasFileMapping(filePath: string): boolean {
    return filePath in this.state.fileMappings;
  }

  /** Get all file mappings */
  getAllFileMappings(): Record<string, SyncMapping> {
    return { ...this.state.fileMappings };
  }

  /**
   * Reverse lookup: find the Obsidian file path for a given Notion page ID.
   * Used during pull to restore [[wiki-links]] from Notion URLs.
   */
  getFilePathByNotionId(notionPageId: string): string | undefined {
    const normalized = normalizeNotionId(notionPageId);
    for (const [filePath, mapping] of Object.entries(this.state.fileMappings)) {
      if (normalizeNotionId(mapping.notionPageId) === normalized) {
        return filePath;
      }
    }
    return undefined;
  }

  // ── Folder Mappings ────────────────────────────────────────

  /** Get the Notion page ID for an Obsidian folder path */
  getFolderMapping(folderPath: string): string | undefined {
    return this.state.folderMappings[folderPath];
  }

  /** Store a folder → Notion page ID mapping */
  setFolderMapping(folderPath: string, notionPageId: string): void {
    this.state.folderMappings[folderPath] = notionPageId;
    this.dirty = true;
  }

  /** Remove a folder mapping */
  removeFolderMapping(folderPath: string): void {
    delete this.state.folderMappings[folderPath];
    this.dirty = true;
  }

  /** Get all folder mappings */
  getAllFolderMappings(): Record<string, string> {
    return { ...this.state.folderMappings };
  }

  // ── Sync Timestamps ────────────────────────────────────────

  /** Record that a full sync was completed */
  setLastFullSync(timestamp: number): void {
    this.state.lastFullSync = timestamp;
    this.dirty = true;
  }

  get lastFullSync(): number {
    return this.state.lastFullSync;
  }

  // ── Change Detection ───────────────────────────────────────

  /** Check if a file needs syncing based on its content hash */
  needsSync(filePath: string, currentHash: string): boolean {
    const mapping = this.state.fileMappings[filePath];
    if (!mapping) return true;
    return mapping.lastSyncedHash !== currentHash;
  }

  // ── Sync Log ───────────────────────────────────────────────

  /** Add a log entry */
  addLog(level: SyncLogEntry["level"], message: string, filePath?: string): void {
    this.log.push({
      timestamp: Date.now(),
      level,
      message,
      filePath,
    });

    // Trim log if it exceeds max size
    if (this.log.length > this.maxLogEntries) {
      this.log = this.log.slice(-this.maxLogEntries);
    }
  }

  /** Get all log entries */
  getLogs(): SyncLogEntry[] {
    return [...this.log];
  }

  /** Clear the log */
  clearLogs(): void {
    this.log = [];
  }

  // ── Sync History ───────────────────────────────────────────

  /** Add a history entry; auto-generates id, caps at 100 entries */
  addHistoryEntry(entry: Omit<SyncHistoryEntry, 'id'>): void {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.history.entries.unshift({ id, ...entry });
    if (this.history.entries.length > 100) {
      this.history.entries = this.history.entries.slice(0, 100);
    }
    this.dirty = true;
  }

  /** Get all history entries */
  getHistory(): SyncHistoryEntry[] {
    return [...this.history.entries];
  }

  /** Get a specific history entry by id */
  getHistoryEntry(id: string): SyncHistoryEntry | undefined {
    return this.history.entries.find(e => e.id === id);
  }

  /** Get the history object for persistence */
  getHistoryForPersistence(): SyncHistory {
    return { entries: [...this.history.entries] };
  }

  /** Load history from persisted data */
  setHistory(history: SyncHistory): void {
    this.history = history;
  }

  // ── Persistence ────────────────────────────────────────────

  /** Get the current sync state for saving */
  getState(): SyncState {
    return { ...this.state };
  }

  /** Replace the current state (used when loading from disk) */
  setState(state: SyncState): void {
    this.state = state;
    this.dirty = false;
  }

  /** Whether state has changed since last save */
  isDirty(): boolean {
    return this.dirty;
  }

  /** Mark state as clean (after saving) */
  markClean(): void {
    this.dirty = false;
  }

  // ── Utilities ──────────────────────────────────────────────

  /** Rename a file or folder path in all mappings */
  renamePath(oldPath: string, newPath: string): void {
    this.remapPaths(this.state.fileMappings, oldPath, newPath);
    this.remapPaths(this.state.folderMappings, oldPath, newPath);
  }

  /**
   * Move `oldPath` — and everything nested under it — to `newPath` within
   * one mapping table. Obsidian reports a folder rename as a single event
   * for the folder, so nested entries have to follow their parent or they
   * go stale and the next push creates duplicate Notion pages.
   */
  private remapPaths<T>(
    table: Record<string, T>,
    oldPath: string,
    newPath: string
  ): void {
    const prefix = `${oldPath}/`;
    for (const key of Object.keys(table)) {
      const isSelf = key === oldPath;
      if (!isSelf && !key.startsWith(prefix)) continue;

      const target = isSelf ? newPath : `${newPath}/${key.slice(prefix.length)}`;
      table[target] = table[key];
      delete table[key];
      this.dirty = true;
    }
  }

  /** Count total synced files */
  get syncedFileCount(): number {
    return Object.keys(this.state.fileMappings).length;
  }

  /** Count total synced folders */
  get syncedFolderCount(): number {
    return Object.keys(this.state.folderMappings).length;
  }

  /** Reset all state (for full re-sync) */
  reset(): void {
    this.state = createDefaultSyncState();
    this.dirty = true;
  }
}

/**
 * Strip dashes from a Notion page ID so IDs from URLs and API can be compared.
 * e.g. "339ee678-f579-814a-a880-dad31be33d8e" → "339ee678f579814aa880dad31be33d8e"
 */
export function normalizeNotionId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}
