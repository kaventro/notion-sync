import { App, PluginSettingTab, Setting, activeWindow } from "obsidian";
import type NotionSyncPlugin from "../main";
import { SyncMode } from "../types";

/**
 * Settings UI tab for the Notion Sync plugin.
 */
export class NotionSyncSettingTab extends PluginSettingTab {
  plugin: NotionSyncPlugin;

  constructor(app: App, plugin: NotionSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    ;

    // ── Connection ────────────────────────────────────────────

    new Setting(containerEl).setName("Connection").setHeading();

    new Setting(containerEl)
      .setName("Notion API token")
      .setDesc(
        "Your Notion integration secret token. " +
        "Create one at notion.so/my-integrations."
      )
      .addText((text) =>
        text
          .setPlaceholder("Secret_...")
          .setValue(this.plugin.settings.notionToken)
          .onChange(async (value) => {
            this.plugin.settings.notionToken = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Root Notion page ID")
      .setDesc(
        "The ID of the Notion page that will serve as the vault root. " +
        "Find it in the page URL: notion.so/Page-Title-<PAGE_ID>."
      )
      .addText((text) =>
        text
          .setPlaceholder("Abc123...")
          .setValue(this.plugin.settings.rootPageId)
          .onChange(async (value) => {
            this.plugin.settings.rootPageId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify that the plugin can connect to Notion.")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setButtonText("Testing...");
          button.setDisabled(true);
          try {
            const ok = await this.plugin.testConnection();
            button.setButtonText(ok ? "Connected!" : "Failed");
          } catch {
            button.setButtonText("Failed");
          }
          activeWindow.setTimeout(() => {
            button.setButtonText("Test");
            button.setDisabled(false);
          }, 2000);
        })
      );

    // ── Sync Mode ─────────────────────────────────────────────

    new Setting(containerEl).setName("Sync mode").setHeading();

    new Setting(containerEl)
      .setName("Sync mode")
      .setDesc("When to automatically sync files to Notion.")
      .addDropdown((dropdown) =>
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
            this.display();
          })
      );

    if (this.plugin.settings.syncMode === SyncMode.Scheduled) {
      new Setting(containerEl)
        .setName("Sync interval (minutes)")
        .setDesc("How often to run automatic sync.")
        .addSlider((slider) =>
          slider
            .setLimits(5, 120, 5)
            .setValue(this.plugin.settings.scheduledIntervalMinutes)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.scheduledIntervalMinutes = value;
              await this.plugin.saveSettings();
              this.plugin.configureSyncMode();
            })
        );
    }

    // ── Content Options ───────────────────────────────────────

    new Setting(containerEl).setName("Content").setHeading();

    new Setting(containerEl)
      .setName("Sync attachments")
      .setDesc(
        "Include images, PDFs, and other embedded files. " +
        "Requires an upload endpoint for local files."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncAttachments)
          .onChange(async (value) => {
            this.plugin.settings.syncAttachments = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.syncAttachments) {
      new Setting(containerEl)
        .setName("Attachment upload URL")
        .setDesc(
          "POST endpoint for uploading local files. " +
          "Should accept multipart/form-data and return { url: string }. " +
          "Leave empty to show placeholders for local attachments."
        )
        .addText((text) =>
          text
            .setPlaceholder("https://your-upload-service.com/upload")
            .setValue(this.plugin.settings.attachmentUploadUrl)
            .onChange(async (value) => {
              this.plugin.settings.attachmentUploadUrl = value.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Sync metadata")
      .setDesc("Include YAML frontmatter as a metadata block in Notion pages.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncMetadata)
          .onChange(async (value) => {
            this.plugin.settings.syncMetadata = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Download images on pull")
      .setDesc(
        "When pulling from Notion, download images to a local _attachments folder " +
        "and replace URLs with Obsidian ![[filename]] embeds."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.downloadImages)
          .onChange(async (value) => {
            this.plugin.settings.downloadImages = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Status ────────────────────────────────────────────────

    new Setting(containerEl).setName("Status").setHeading();

    const statusEl = containerEl.createDiv({ cls: "notion-sync-status" });
    statusEl.createEl("p", {
      text: `Synced files: ${this.plugin.stateManager.syncedFileCount}`,
    });
    statusEl.createEl("p", {
      text: `Synced folders: ${this.plugin.stateManager.syncedFolderCount}`,
    });

    const lastSync = this.plugin.stateManager.lastFullSync;
    if (lastSync > 0) {
      statusEl.createEl("p", {
        text: `Last full sync: ${new Date(lastSync).toLocaleString()}`,
      });
    }

    // ── Danger Zone ───────────────────────────────────────────

    new Setting(containerEl).setName("Danger zone").setHeading();

    new Setting(containerEl)
      .setName("Reset sync state")
      .setDesc(
        "Clear all sync mappings. The next sync will treat everything as new. " +
        "Existing Notion pages will NOT be deleted."
      )
      .addButton((button) =>
        button
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            this.plugin.stateManager.reset();
            await this.plugin.saveState();
            this.display();
          })
      );
  }
}
