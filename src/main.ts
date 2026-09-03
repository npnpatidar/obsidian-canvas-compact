import { Plugin, Notice, TFile, ItemView, Menu } from "obsidian";
import type { CanvasData, CanvasView, Canvas } from "./Canvas.d";
import { fitAllNodes, DEFAULT_FIT_OPTIONS } from "./fit";
import { packLayout, packingStats, DEFAULT_PACK_OPTIONS } from "./pack";
import type { FitOptions } from "./fit";
import type { PackOptions } from "./pack";

interface CanvasCompactSettings {
  fitMinHeight: number;
  fitMaxHeight: number; // -1 unlimited
  fitSnapToGrid: boolean;
  packGap: number;
  packPadding: number;
  packStrategy: PackOptions["strategy"];
  packSortBy: PackOptions["sortBy"];
  packColumns?: number;
}

const DEFAULT_SETTINGS: CanvasCompactSettings = {
  fitMinHeight: 60,
  fitMaxHeight: -1,
  fitSnapToGrid: true,
  packGap: 20,
  packPadding: 20,
  packStrategy: "maxrects",
  packSortBy: "heightDesc",
  packColumns: undefined,
};

function isCanvasFile(f: TFile | null): boolean {
  return !!f && f.extension === "canvas";
}

function getActiveCanvasView(app: Plugin["app"]): CanvasView | null {
  const view = app.workspace.getActiveViewOfType(ItemView as unknown as Parameters<typeof app.workspace.getActiveViewOfType>[0]) as unknown as CanvasView | null;
  if (view && view.getViewType() === "canvas" && (view as unknown as { canvas?: Canvas }).canvas) return view as unknown as CanvasView;
  // fallback: iterate leaves
  for (const leaf of app.workspace.getLeavesOfType("canvas")) {
    const v = leaf.view as unknown as CanvasView;
    if (v && v.canvas) {
      // prefer active leaf's file matching active file
      const active = app.workspace.getActiveFile();
      if (active && v.file?.path === active.path) return v;
    }
  }
  // last resort: any canvas leaf
  const anyLeaf = app.workspace.getLeavesOfType("canvas")[0];
  if (anyLeaf) return (anyLeaf.view as unknown as CanvasView) ?? null;
  return null;
}

function buildDomMap(canvas: Canvas): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  for (const [id, node] of canvas.nodes) {
    if (node.nodeEl) map.set(id, node.nodeEl);
  }
  return map;
}

export default class CanvasCompactPlugin extends Plugin {
  settings: CanvasCompactSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    // Register settings tab
    const { CanvasCompactSettingTab } = await import("./settings");
    this.addSettingTab(new CanvasCompactSettingTab(this.app, this));

    // Commands — all guarded to canvas context
    this.addCommand({
      id: "canvas-compact-fit",
      name: "Fit cards to content (resize height)",
      checkCallback: this.withCanvas((canvas) => this.runFit(canvas)),
    });

    this.addCommand({
      id: "canvas-compact-pack",
      name: "Pack layout — minimum area (MaxRects)",
      checkCallback: this.withCanvas((canvas) => this.runPack(canvas, { strategy: "maxrects" })),
    });

    this.addCommand({
      id: "canvas-compact-pack-masonry",
      name: "Pack layout — preserve order (Masonry)",
      checkCallback: this.withCanvas((canvas) => this.runPack(canvas, { strategy: "masonry" })),
    });

    this.addCommand({
      id: "canvas-compact-fit-and-pack",
      name: "Fit + Pack (compact all cards)",
      checkCallback: this.withCanvas((canvas) => this.runFitAndPack(canvas)),
    });

    // Context menu on canvas
    this.registerEvent(
      (this.app.workspace as unknown as { on: (ev: string, cb: (...args: unknown[]) => unknown) => { unload: () => void } }).on(
        "file-menu",
        (menu: unknown, file: unknown) => {
          if (!(file instanceof TFile) || !isCanvasFile(file)) return;
          (menu as Menu).addItem((item) =>
            item
              .setTitle("Canvas Compact: Fit + Pack this file")
              .setIcon("layout-dashboard")
              .onClick(async () => {
                await this.fitAndPackFile(file as TFile);
              })
          );
        }
      )
    );

    console.log("Canvas Compact loaded");
  }

  onunload(): void {
    console.log("Canvas Compact unloaded");
  }

  // ── Settings ──
  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<CanvasCompactSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ── Guard ──
  private withCanvas(fn: (canvas: Canvas) => void | Promise<void>) {
    return (checking: boolean): boolean | void => {
      const view = getActiveCanvasView(this.app);
      if (!view) {
        if (checking) return false;
        new Notice("Open a canvas first.");
        return;
      }
      if (checking) return true;
      void fn(view.canvas);
    };
  }

  // ── Core ops (live canvas path) ──

  private async runFit(canvas: Canvas): Promise<void> {
    const data = canvas.getData() as CanvasData;
    const domMap = buildDomMap(canvas);
    const opts: FitOptions = {
      minHeight: this.settings.fitMinHeight,
      maxHeight: this.settings.fitMaxHeight,
      snapToGrid: this.settings.fitSnapToGrid,
      useDomWhenAvailable: true,
    };
    const before = data.nodes.length;
    const { nodes: fitted, changed } = fitAllNodes([...data.nodes], opts, domMap);

    if (changed === 0) {
      new Notice("All cards already fit content.");
      return;
    }
    canvas.setData({ ...data, nodes: fitted });
    canvas.requestSave(false);
    new Notice(`Fit ${changed}/${before} cards to content.`);
  }

  private async runPack(canvas: Canvas, override?: Partial<PackOptions>): Promise<void> {
    const data = canvas.getData() as CanvasData;
    const beforeNodes = [...data.nodes];
    const opts: PackOptions = {
      ...DEFAULT_PACK_OPTIONS,
      gap: this.settings.packGap,
      padding: this.settings.packPadding,
      strategy: this.settings.packStrategy,
      sortBy: this.settings.packSortBy,
      columns: this.settings.packColumns,
      ...override,
    };
    const packed = packLayout([...data.nodes], opts);
    const stats = packingStats(beforeNodes, packed);
    canvas.setData({ ...data, nodes: packed });
    canvas.requestSave(false);
    new Notice(`Packed ${packed.length} cards — saved ${stats.savedPct}% area (${stats.areaBefore} → ${stats.areaAfter})`);
  }

  private async runFitAndPack(canvas: Canvas): Promise<void> {
    const data = canvas.getData() as CanvasData;
    const beforeNodes = [...data.nodes];
    const domMap = buildDomMap(canvas);

    const fitOpts: FitOptions = {
      minHeight: this.settings.fitMinHeight,
      maxHeight: this.settings.fitMaxHeight,
      snapToGrid: this.settings.fitSnapToGrid,
      useDomWhenAvailable: true,
    };
    const { nodes: fitted } = fitAllNodes([...data.nodes], fitOpts, domMap);

    const packOpts: PackOptions = {
      ...DEFAULT_PACK_OPTIONS,
      gap: this.settings.packGap,
      padding: this.settings.packPadding,
      strategy: this.settings.packStrategy,
      sortBy: this.settings.packSortBy,
      columns: this.settings.packColumns,
    };
    const packed = packLayout(fitted, packOpts);
    const stats = packingStats(beforeNodes, packed);

    canvas.setData({ ...data, nodes: packed });
    canvas.requestSave(false);
    new Notice(`Fit + Pack: ${packed.length} cards, saved ${stats.savedPct}% area`);
  }

  // ── File path (when canvas not open — e.g., file menu) ──
  private async fitAndPackFile(file: TFile): Promise<void> {
    const raw = await this.app.vault.cachedRead(file);
    let data: CanvasData;
    try {
      data = JSON.parse(raw) as CanvasData;
    } catch {
      new Notice("Invalid canvas file");
      return;
    }
    const beforeNodes = [...data.nodes];

    // Heuristic-only (no DOM when file not open)
    const fitOpts: FitOptions = {
      minHeight: this.settings.fitMinHeight,
      maxHeight: this.settings.fitMaxHeight,
      snapToGrid: this.settings.fitSnapToGrid,
      useDomWhenAvailable: false,
    };
    const { nodes: fitted } = fitAllNodes([...data.nodes], fitOpts);

    const packOpts: PackOptions = {
      ...DEFAULT_PACK_OPTIONS,
      gap: this.settings.packGap,
      padding: this.settings.packPadding,
      strategy: this.settings.packStrategy,
      sortBy: this.settings.packSortBy,
      columns: this.settings.packColumns,
    };
    const packed = packLayout(fitted, packOpts);
    const stats = packingStats(beforeNodes, packed);

    data.nodes = packed;
    await this.app.vault.modify(file, JSON.stringify(data, null, 2));

    // Also update live view if open
    const view = getActiveCanvasView(this.app);
    if (view && view.file.path === file.path) {
      view.canvas.setData(data);
      view.canvas.requestSave(false);
    }
    new Notice(`Fit + Pack ${file.basename}: saved ${stats.savedPct}% area`);
  }
}
