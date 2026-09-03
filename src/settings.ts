import { App, PluginSettingTab, Setting } from "obsidian";
import type CanvasCompactPlugin from "./main";

export class CanvasCompactSettingTab extends PluginSettingTab {
  plugin: CanvasCompactPlugin;

  constructor(app: App, plugin: CanvasCompactPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Canvas Compact — settings" });

    new Setting(containerEl)
      .setName("Minimum card height")
      .setDesc("Floor for fit-to-content (matches advanced-canvas minContainerDimension).")
      .addSlider((s) =>
        s
          .setLimits(40, 120, 10)
          .setValue(this.plugin.settings.fitMinHeight)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.fitMinHeight = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Maximum card height")
      .setDesc("-1 = unlimited. Caps fitted height (e.g., 600 keeps cards readable).")
      .addText((t) => {
        t.setValue(String(this.plugin.settings.fitMaxHeight));
        t.inputEl.type = "number";
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.fitMaxHeight = Number.isNaN(n) ? -1 : n;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Snap fitted height to grid (20px)")
      .setDesc("Matches Canvas grid size and advanced-canvas behavior.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.fitSnapToGrid).onChange(async (v) => {
          this.plugin.settings.fitSnapToGrid = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Packing" });

    new Setting(containerEl)
      .setName("Gap between cards (px)")
      .setDesc("Spacing after pack. 20 matches Obsidian default.")
      .addSlider((s) =>
        s
          .setLimits(0, 60, 5)
          .setValue(this.plugin.settings.packGap)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.packGap = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Outer padding (px)")
      .setDesc("Margin around packed bounding box.")
      .addSlider((s) =>
        s
          .setLimits(0, 60, 5)
          .setValue(this.plugin.settings.packPadding)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.packPadding = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Pack strategy")
      .setDesc("MaxRects: densest (saves most area). Masonry: preserves reading order.")
      .addDropdown((d) =>
        d
          .addOption("maxrects", "MaxRects (compact)")
          .addOption("masonry", "Masonry (preserve order)")
          .setValue(this.plugin.settings.packStrategy)
          .onChange(async (v) => {
            this.plugin.settings.packStrategy = v as "maxrects" | "masonry";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sort before packing")
      .setDesc("Order to place cards. HeightDesc usually packs tightest.")
      .addDropdown((d) =>
        d
          .addOption("heightDesc", "Height descending (recommended)")
          .addOption("areaDesc", "Area descending")
          .addOption("widthDesc", "Width descending")
          .addOption("input", "Keep current order")
          .setValue(this.plugin.settings.packSortBy)
          .onChange(async (v) => {
            this.plugin.settings.packSortBy = v as typeof this.plugin.settings.packSortBy;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Masonry columns (auto if empty)")
      .setDesc("Only for Masonry strategy. Leave empty for auto (~4-6 cols).")
      .addText((t) => {
        t.setValue(this.plugin.settings.packColumns ? String(this.plugin.settings.packColumns) : "");
        t.setPlaceholder("auto");
        t.inputEl.type = "number";
        t.onChange(async (v) => {
          this.plugin.settings.packColumns = v ? parseInt(v, 10) : undefined;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("p", {
      text: "Tip: Use “Fit + Pack” for one-shot compact. Undo (Ctrl+Z) works after each command.",
      cls: "setting-item-description",
    });
  }
}
