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

    new Setting(containerEl)
      .setName("Exact crossing minimization threshold")
      .setDesc("Clusters up to this many cards get the provably minimal crossing count; larger clusters use a fast heuristic. Applies to both Clean and DagCola layout. Exact minimisation is exponential, so the value is capped at 60.")
      .addSlider((s) =>
        s
          .setLimits(10, 60, 5)
          .setValue(this.plugin.settings.dagcolaExactDecrossThreshold)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.dagcolaExactDecrossThreshold = v;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("p", {
      text: "Tip: Use \"Clean layout\" when you want no overlaps and as few connection crossings as the graph allows — a non-planar canvas cannot be drawn with zero crossings, and any that remain are reported.",
      cls: "setting-item-description",
    });

    containerEl.createEl("h3", { text: "DagCola layout (d3-dag + webcola)" });

    new Setting(containerEl)
      .setName("Enable DagCola layout")
      .setDesc("Adds the DagCola commands and the file-menu action. Off means only the Clean layout engine is available.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.dagcolaEnabled).onChange(async (v) => {
          this.plugin.settings.dagcolaEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Use webcola refinement")
      .setDesc("After d3-dag places the cards, let webcola pull them in as tight as its constraints allow: no overlaps, connections pointing parent-to-child, and group cards kept together. A refinement is only kept when it is still overlap-free and more compact than the layered layout.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.dagcolaUseColaRefinement).onChange(async (v) => {
          this.plugin.settings.dagcolaUseColaRefinement = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("p", {
      text: "DagCola lays each cluster out with d3-dag's layered algorithm, then optionally tightens it with webcola's constraint solver, and finishes through the same packing, connection-routing and label-placement pipeline as Clean layout. Direction, spacing, padding, label spacing and the crossing threshold come from the Clean layout settings above.",
      cls: "setting-item-description",
    });

    containerEl.createEl("h3", { text: "Diagnostics" });

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Emit per-pass layout-engine diagnostics to the developer console (Cmd/Ctrl+Shift+I). Helps diagnose layout issues; leave off for normal use.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.debug).onChange(async (v) => {
          this.plugin.settings.debug = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
