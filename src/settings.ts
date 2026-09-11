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

    containerEl.createEl("h3", { text: "Clean layout" });

    new Setting(containerEl)
      .setName("Direction")
      .setDesc("Top→bottom / left→right for flow charts. Balanced splits each branch either side of the root, like a mind map.")
      .addDropdown((d) =>
        d
          .addOption("top-to-bottom", "Top → bottom")
          .addOption("left-to-right", "Left → right")
          .addOption("balanced", "Balanced (mind map)")
          .setValue(this.plugin.settings.cleanDirection)
          .onChange(async (v) => {
            this.plugin.settings.cleanDirection = v as "top-to-bottom" | "left-to-right" | "balanced";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Space between cards (px)")
      .setDesc("Minimum gap in a clean layout. Crossings are minimised; card and label overlaps are eliminated where space allows.")
      .addSlider((s) =>
        s
          .setLimits(20, 160, 10)
          .setValue(this.plugin.settings.cleanGap)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.cleanGap = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Outer padding (px)")
      .setDesc("Margin around the cleaned layout.")
      .addSlider((s) =>
        s
          .setLimits(0, 120, 10)
          .setValue(this.plugin.settings.cleanPadding)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.cleanPadding = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Reserve space for connection labels")
      .setDesc("Widen layering so connection labels sit clear of cards and other connections.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.cleanReserveLabelSpace).onChange(async (v) => {
          this.plugin.settings.cleanReserveLabelSpace = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("p", {
      text: "Tip: Use “Clean layout” when you want no overlaps and as few connection crossings as the graph allows — a non-planar canvas cannot be drawn with zero crossings, and any that remain are reported.",
      cls: "setting-item-description",
    });
  }
}
