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

    containerEl.createEl("h3", { text: "Connections (edge-aware)" });

    new Setting(containerEl)
      .setName("Optimize connections after packing")
      .setDesc("Re-attach edges to nearest sides (like optimize-canvas-connections). Keeps edges short and visible.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.optimizeEdges).onChange(async (v) => {
          this.plugin.settings.optimizeEdges = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Preserve axes (like 'preserve-axes' mode)")
      .setDesc("If on, only switch left↔right or top↔bottom, never vertical→horizontal. Preserves flow direction.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.preserveAxes).onChange(async (v) => {
          this.plugin.settings.preserveAxes = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Force layout iterations")
      .setDesc("Higher = tighter clusters but slower. 250 is good for <50 nodes.")
      .addSlider((s) =>
        s
          .setLimits(50, 600, 50)
          .setValue(this.plugin.settings.graphIterations)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.graphIterations = v;
            await this.plugin.saveSettings();
          })
      );

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
      text: "Tip: Use “Fit + Pack” for isolated cards. Use “Fit + Graph Pack” when cards are connected. Use “Clean layout” when you want no overlaps and as few connection crossings as the graph allows — a non-planar canvas cannot be drawn with zero crossings, and any that remain are reported.",
      cls: "setting-item-description",
    });
  }
}
