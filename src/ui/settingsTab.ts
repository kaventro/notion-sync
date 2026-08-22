import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NotionSyncPlugin from "../main";
import { SyncMode } from "../types";

/**
 * One row of the settings tab, shared by both renderers below so the
 * declarative definitions and the imperative fallback can never drift.
 */
interface SettingRow {
  name: string;
  /** Plain text — this is what Obsidian's settings search indexes. */
  desc?: string;
  /** Link appended to the description when the row is rendered. */
  link?: { text: string; href: string };
  /** Rows whose settings do not apply right now are left out. */
  visible?: () => boolean;
  /** Attaches the row's controls to an already-named Setting. */
  build: (setting: Setting) => void;
}

interface SettingSection {
  heading: string;
  rows: SettingRow[];
}

/**
 * Settings UI tab for the Notion Sync plugin. The rows are described once
 * in sections() and rendered either declaratively (Obsidian 1.13+, which
 * also puts them in the settings search) or imperatively via display().
 */
export class NotionSyncSettingTab extends PluginSettingTab {
  /** Notion docs section that explains extracting a page ID from its URL. */
  private static readonly PAGE_ID_HELP_URL =
    "https://developers.notion.com/guides/data-apis/working-with-page-content#creating-a-page-with-content";

  /** Notion page for creating/managing integration tokens. */
  private static readonly TOKEN_HELP_URL =
    "https://app.notion.com/developers/tokens";

  plugin: NotionSyncPlugin;

  constructor(app: App, plugin: NotionSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Declarative settings, so Obsidian renders the rows itself and indexes
   * their names and descriptions for the settings search.
   *
   * Every row keeps its own render callback instead of a `control` binding:
   * a bound control persists by writing `plugin.settings` through
   * saveData(), but this plugin's data.json also holds the sync mappings
   * and history, which that write would drop. Going through
   * plugin.saveSettings() keeps the whole file intact.
   */
  getSettingDefinitions() {
    return this.sections().map((section) => ({
      type: "group" as const,
      heading: section.heading,
      items: section.rows.map((row) => ({
        name: row.name,
        desc: row.desc,
        visible: row.visible,
        render: (setting: Setting): void => {
          this.applyDesc(setting, row);
          row.build(setting);
        },
      })),
    }));
  }

  /**
   * Imperative fallback. PluginSettingTab declares display() abstract, and
   * Obsidian falls back to it whenever the definitions above are not used.
   */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    for (const section of this.sections()) {
      new Setting(containerEl).setName(section.heading).setHeading();

      for (const row of section.rows) {
        if (row.visible && !row.visible()) continue;

        const setting = new Setting(containerEl).setName(row.name);
        this.applyDesc(setting, row);
        row.build(setting);
      }
    }
  }

  // ── Rows ──────────────────────────────────────────────────

  private sections(): SettingSection[] {
    return [
      { heading: "Connection", rows: this.connectionRows() },
      { heading: "Sync mode", rows: this.syncModeRows() },
      { heading: "Content", rows: this.contentRows() },
      { heading: "Status", rows: this.statusRows() },
      { heading: "Danger zone", rows: this.dangerRows() },
    ];
  }

  private connectionRows(): SettingRow[] {
    return [
      {
        name: "Notion API token",
        desc: "Your Notion integration secret token.",
        link: { text: "Create one here", href: NotionSyncSettingTab.TOKEN_HELP_URL },
        build: (setting) => {
          setting.addText((text) =>
            text
              .setPlaceholder("Secret_...")
              .setValue(this.plugin.settings.notionToken)
              .onChange(async (value) => {
                this.plugin.settings.notionToken = value;
                await this.plugin.saveSettings();
              })
          );
        },
      },
      {
        name: "Root Notion page ID",
        desc:
          "The ID of the Notion page that will serve as the vault root. " +
          "Find it in the page URL: notion.so/Page-Title-<PAGE_ID>.",
        link: {
          text: "How to find the page ID",
          href: NotionSyncSettingTab.PAGE_ID_HELP_URL,
        },
        build: (setting) => {
          setting
            .addText((text) =>
              text
                .setPlaceholder("Abc123...")
                .setValue(this.plugin.settings.rootPageId)
                .onChange(async (value) => {
                  this.plugin.settings.rootPageId = value.trim();
                  await this.plugin.saveSettings();
                })
            )
            .addExtraButton((button) =>
              button
                .setIcon("help-circle")
                .setTooltip(
                  'Open the page in Notion, click ••• (top-right) ' +
                  'or Share, then "Copy link". The page ID is the 32-character ' +
                  'string at the end of the URL — after the last "-" and ' +
                  'before any "?".'
                )
                .onClick(() => {
                  window.open(NotionSyncSettingTab.PAGE_ID_HELP_URL, "_blank");
                })
            );
        },
      },
      {
        name: "Test connection",
        desc: "Verify that the plugin can connect to Notion.",
        build: (setting) => {
          setting.addButton((button) =>
            button.setButtonText("Test").onClick(async () => {
              button.setButtonText("Testing...");
              button.setDisabled(true);
              try {
                const ok = await this.plugin.testConnection();
                button.setButtonText(ok ? "Connected!" : "Failed");
              } catch {
                button.setButtonText("Failed");
              }
              window.setTimeout(() => {
                button.setButtonText("Test");
                button.setDisabled(false);
              }, 2000);
            })
          );
        },
      },
    ];
  }

  private syncModeRows(): SettingRow[] {
    return [
      {
        name: "Sync mode",
        desc: "When to automatically sync files to Notion.",
        build: (setting) => {
          setting.addDropdown((dropdown) =>
            dropdown
              .addOption(SyncMode.Manual, "Manual only")
              .addOption(SyncMode.CurrentFile, "Current file on command")
              .addOption(SyncMode.OnSave, "Auto sync on save")
              .addOption(SyncMode.Scheduled, "Scheduled interval")
              .setValue(this.plugin.settings.syncMode)
              .onChange(async (value) => {
                this.plugin.settings.syncMode = value as SyncMode;
                await this.plugin.saveSettings();
                this.plugin.configureSyncMode();
              })
          );
        },
      },
      {
        name: "Sync interval (minutes)",
        desc: "How often to run automatic sync.",
        visible: () => this.plugin.settings.syncMode === SyncMode.Scheduled,
        build: (setting) => {
          setting.addSlider((slider) =>
            slider
              .setLimits(5, 120, 5)
              .setValue(this.plugin.settings.scheduledIntervalMinutes)
              .onChange(async (value) => {
                this.plugin.settings.scheduledIntervalMinutes = value;
                await this.plugin.saveSettings();
                this.plugin.configureSyncMode();
              })
          );
        },
      },
    ];
  }

  private contentRows(): SettingRow[] {
    return [
      {
        name: "Sync attachments",
        desc:
          "Include images, PDFs, and other embedded files. " +
          "Requires an upload endpoint for local files.",
        build: (setting) => {
          setting.addToggle((toggle) =>
            toggle
              .setValue(this.plugin.settings.syncAttachments)
              .onChange(async (value) => {
                this.plugin.settings.syncAttachments = value;
                await this.plugin.saveSettings();
              })
          );
        },
      },
      {
        name: "Attachment upload URL",
        desc:
          "POST endpoint for uploading local files. " +
          "Should accept multipart/form-data and return { url: string }. " +
          "Leave empty to show placeholders for local attachments.",
        visible: () => this.plugin.settings.syncAttachments,
        build: (setting) => {
          setting.addText((text) =>
            text
              .setPlaceholder("https://your-upload-service.com/upload")
              .setValue(this.plugin.settings.attachmentUploadUrl)
              .onChange(async (value) => {
                this.plugin.settings.attachmentUploadUrl = value.trim();
                await this.plugin.saveSettings();
              })
          );
        },
      },
      {
        name: "Sync metadata",
        desc: "Include YAML frontmatter as a metadata block in Notion pages.",
        build: (setting) => {
          setting.addToggle((toggle) =>
            toggle
              .setValue(this.plugin.settings.syncMetadata)
              .onChange(async (value) => {
                this.plugin.settings.syncMetadata = value;
                await this.plugin.saveSettings();
              })
          );
        },
      },
      {
        name: "Download images on pull",
        desc:
          "When pulling from Notion, download images to a local _attachments folder " +
          "and replace URLs with Obsidian ![[filename]] embeds.",
        build: (setting) => {
          setting.addToggle((toggle) =>
            toggle
              .setValue(this.plugin.settings.downloadImages)
              .onChange(async (value) => {
                this.plugin.settings.downloadImages = value;
                await this.plugin.saveSettings();
              })
          );
        },
      },
    ];
  }

  private statusRows(): SettingRow[] {
    return [
      {
        name: "Sync status",
        desc: "How many files and folders are mapped to Notion, and when the last full sync ran.",
        build: (setting) => {
          const { stateManager } = this.plugin;
          const parts = [
            `Synced files: ${stateManager.syncedFileCount}`,
            `Synced folders: ${stateManager.syncedFolderCount}`,
          ];
          if (stateManager.lastFullSync > 0) {
            parts.push(
              `Last full sync: ${new Date(stateManager.lastFullSync).toLocaleString()}`
            );
          }
          // Replaces the generic description above with the live counts.
          setting.setDesc(parts.join(" · "));
        },
      },
    ];
  }

  private dangerRows(): SettingRow[] {
    return [
      {
        name: "Reset sync state",
        desc:
          "Clear all sync mappings. The next sync will treat everything as new. " +
          "Existing Notion pages will NOT be deleted.",
        build: (setting) => {
          setting.addButton((button) =>
            button
              .setButtonText("Reset")
              .setDestructive()
              .onClick(async () => {
                this.plugin.stateManager.reset();
                await this.plugin.saveState();
                new Notice("Sync state reset");
              })
          );
        },
      },
    ];
  }

  // ── Internal ──────────────────────────────────────────────

  /** Set the row description, appending its help link when it has one. */
  private applyDesc(setting: Setting, row: SettingRow): void {
    const desc = row.desc;
    if (!desc) return;

    const link = row.link;
    if (!link) {
      setting.setDesc(desc);
      return;
    }

    setting.setDesc(
      createFragment((frag) => {
        frag.appendText(`${desc} `);
        frag.createEl("a", {
          text: link.text,
          href: link.href,
          attr: { target: "_blank", rel: "noopener" },
        });
      })
    );
  }
}
