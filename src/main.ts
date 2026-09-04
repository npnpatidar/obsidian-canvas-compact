import { Plugin, Notice, TFile, ItemView, Menu } from "obsidian";
import type { CanvasData, CanvasView, Canvas } from "./Canvas.d";
import { fitAllNodes } from "./fit";
import { packLayout, packingStats, DEFAULT_PACK_OPTIONS } from "./pack";
import { graphPack, optimizeEdges, tidyLayout } from "./graph";
import type { FitOptions } from "./fit";
import type { PackOptions } from "./pack";
import type { OptimizeMode } from "./graph";

interface CanvasCompactSettings {
  fitMinHeight: number;
  fitMaxHeight: number; // -1 unlimited
  fitSnapToGrid: boolean;
  packGap: number;
  packPadding: number;
  packStrategy: PackOptions["strategy"];
  packSortBy: PackOptions["sortBy"];
  packColumns?: number;
  optimizeEdges: boolean;
  preserveAxes: boolean;
  graphIterations: number;
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
  optimizeEdges: true,
  preserveAxes: false,
  graphIterations: 250,
};

function isCanvasFile(f: TFile | null): boolean {
  return !!f && f.extension === "canvas";
}

function getActiveCanvasView(app: Plugin["app"]): CanvasView | null {
  const view = app.workspace.getActiveViewOfType(ItemView as unknown as Parameters<typeof app.workspace.getActiveViewOfType>[0]) as unknown as CanvasView | null;
  if (view && view.getViewType() === "canvas" && (view as unknown as { canvas?: Canvas }).canvas) return view as unknown as CanvasView;
  for (const leaf of app.workspace.getLeavesOfType("canvas")) {
    const v = leaf.view as unknown as CanvasView;
    if (v && v.canvas) {
      const active = app.workspace.getActiveFile();
      if (active && v.file?.path === active.path) return v;
    }
  }
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

function totalEdgeLength(nodes: CanvasData["nodes"], edges: CanvasData["edges"]): number {
  const m = new Map(nodes.map((n) => [n.id, n]));
  let sum = 0;
  for (const e of edges) {
    const a = m.get(e.fromNode);
    const b = m.get(e.toNode);
    if (!a || !b) continue;
    const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
    const bx = b.x + b.width / 2, by = b.y + b.height / 2;
    sum += Math.hypot(ax - bx, ay - by);
  }
  return Math.round(sum);
}

export default class CanvasCompactPlugin extends Plugin {
  settings: CanvasCompactSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    const { CanvasCompactSettingTab } = await import("./settings");
    this.addSettingTab(new CanvasCompactSettingTab(this.app, this));

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
    // ── Edge-aware commands (new) ──
    this.addCommand({
      id: "canvas-compact-optimize-edges",
      name: "Optimize connections (nearest edges)",
      checkCallback: this.withCanvas((canvas) => this.runOptimizeEdges(canvas)),
    });
    this.addCommand({
      id: "canvas-compact-graph-pack",
      name: "Pack layout — edge-aware (minimize area + connections)",
      checkCallback: this.withCanvas((canvas) => this.runGraphPack(canvas)),
    });
    this.addCommand({
      id: "canvas-compact-fit-and-graph-pack",
      name: "Fit + Graph Pack (edge-aware compact)",
      checkCallback: this.withCanvas((canvas) => this.runFitAndGraphPack(canvas)),
    });
    this.addCommand({
      id: "canvas-compact-tidy-change-dir",
      name: "Tidy layout — allow changing connection directions",
      checkCallback: this.withCanvas((canvas) => this.runTidy(canvas, false)),
    });
    this.addCommand({
      id: "canvas-compact-tidy-preserve-dir",
      name: "Tidy layout — preserve existing connection directions",
      checkCallback: this.withCanvas((canvas) => this.runTidy(canvas, true)),
    });

    this.registerEvent(
      (this.app.workspace as unknown as { on: (ev: string, cb: (...args: unknown[]) => unknown) => { unload: () => void } }).on(
        "file-menu",
        (menu: unknown, file: unknown) => {
          if (!(file instanceof TFile) || !isCanvasFile(file)) return;
          (menu as Menu).addItem((item) =>
            item
              .setTitle("Canvas Compact: Fit + Pack this file")
              .setIcon("layout-dashboard")
              .onClick(async () => { await this.fitAndPackFile(file as TFile); })
          );
          (menu as Menu).addItem((item) =>
            item
              .setTitle("Canvas Compact: Fit + Graph Pack (edge-aware)")
              .setIcon("share-2")
              .onClick(async () => { await this.fitAndGraphPackFile(file as TFile); })
          );
        }
      )
    );
    console.log("Canvas Compact loaded");
  }

  onunload(): void { console.log("Canvas Compact unloaded"); }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<CanvasCompactSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  private withCanvas(fn: (canvas: Canvas) => void | Promise<void>) {
    return (checking: boolean): boolean | void => {
      const view = getActiveCanvasView(this.app);
      if (!view) { if (checking) return false; new Notice("Open a canvas first."); return; }
      if (checking) return true;
      void fn(view.canvas);
    };
  }

  // ── Core ops ──
  private async runFit(canvas: Canvas): Promise<void> {
    const data = canvas.getData() as CanvasData;
    const domMap = buildDomMap(canvas);
    const opts: FitOptions = {
      minHeight: this.settings.fitMinHeight, maxHeight: this.settings.fitMaxHeight,
      snapToGrid: this.settings.fitSnapToGrid, useDomWhenAvailable: true,
    };
    const before = data.nodes.length;
    const { nodes: fitted, changed } = fitAllNodes([...data.nodes], opts, domMap);
    if (changed === 0) { new Notice("All cards already fit content."); return; }
    canvas.setData({ ...data, nodes: fitted });
    canvas.requestSave(false);
    new Notice(`Fit ${changed}/${before} cards to content.`);
  }

  private async runPack(canvas: Canvas, override?: Partial<PackOptions>): Promise<void> {
    const data = canvas.getData() as CanvasData;
    // If edges exist, use edge-aware graphPack by default to ensure visibility while minimizing area
    if (data.edges.length > 0 && this.settings.optimizeEdges) {
      return this.runGraphPack(canvas);
    }
    const beforeNodes = [...data.nodes];
    const beforeLen = totalEdgeLength(beforeNodes, data.edges);
    const opts: PackOptions = {
      ...DEFAULT_PACK_OPTIONS, gap: this.settings.packGap, padding: this.settings.packPadding,
      strategy: this.settings.packStrategy, sortBy: this.settings.packSortBy, columns: this.settings.packColumns, ...override,
    };
    let packed = packLayout([...data.nodes], opts);
    let edges = data.edges;
    if (edges.length > 0 && this.settings.optimizeEdges) {
      const mode: OptimizeMode = this.settings.preserveAxes ? "preserve-axes" : "shortest";
      edges = optimizeEdges(packed, edges, mode);
    }
    const stats = packingStats(beforeNodes, packed);
    const afterLen = totalEdgeLength(packed, edges);
    const edgeInfo = edges.length ? `, edges ${beforeLen}→${afterLen}px` : "";
    canvas.setData({ ...data, nodes: packed, edges });
    canvas.requestSave(false);
    new Notice(`Packed ${packed.length} cards — saved ${stats.savedPct}% area (${stats.areaBefore}→${stats.areaAfter})${edgeInfo}`);
  }

  private async runOptimizeEdges(canvas: Canvas): Promise<void> {
    const data = canvas.getData() as CanvasData;
    if (data.edges.length === 0) { new Notice("No connections to optimize."); return; }
    const mode: OptimizeMode = this.settings.preserveAxes ? "preserve-axes" : "shortest";
    const before = totalEdgeLength(data.nodes, data.edges);
    const optimized = optimizeEdges(data.nodes, data.edges, mode);
    const after = totalEdgeLength(data.nodes, optimized);
    canvas.setData({ ...data, edges: optimized });
    canvas.requestSave(false);
    new Notice(`Optimized ${optimized.length} connections: ${before}→${after}px (${mode})`);
  }

  private async runGraphPack(canvas: Canvas): Promise<void> {
    const data = canvas.getData() as CanvasData;
    const beforeNodes = [...data.nodes];
    const beforeLen = totalEdgeLength(beforeNodes, data.edges);
    if (data.edges.length === 0) {
      // fallback to regular pack if isolated
      return this.runPack(canvas);
    }
    const opts: PackOptions & { optimizeMode?: OptimizeMode; iterations?: number } = {
      ...DEFAULT_PACK_OPTIONS, gap: this.settings.packGap, padding: this.settings.packPadding,
      strategy: "maxrects", sortBy: this.settings.packSortBy, columns: this.settings.packColumns,
      optimizeMode: this.settings.preserveAxes ? "preserve-axes" : "shortest",
      iterations: this.settings.graphIterations,
    };
    const { nodes: packed, edges } = graphPack([...data.nodes], [...data.edges], opts);
    const stats = packingStats(beforeNodes, packed);
    const afterLen = totalEdgeLength(packed, edges);
    canvas.setData({ ...data, nodes: packed, edges });
    canvas.requestSave(false);
    new Notice(`Graph Pack: ${packed.length} cards, ${edges.length} edges — saved ${stats.savedPct}% area, edges ${beforeLen}→${afterLen}px`);
  }

  private async runFitAndPack(canvas: Canvas): Promise<void> {
    // edge-aware by default: if edges exist, use graph pack to keep connections visible
    const data = canvas.getData() as CanvasData;
    if (data.edges.length > 0 && this.settings.optimizeEdges) {
      return this.runFitAndGraphPack(canvas);
    }
    const beforeNodes = [...data.nodes];
    const domMap = buildDomMap(canvas);
    const fitOpts: FitOptions = {
      minHeight: this.settings.fitMinHeight, maxHeight: this.settings.fitMaxHeight,
      snapToGrid: this.settings.fitSnapToGrid, useDomWhenAvailable: true,
    };
    const { nodes: fitted } = fitAllNodes([...data.nodes], fitOpts, domMap);
    const packOpts: PackOptions = {
      ...DEFAULT_PACK_OPTIONS, gap: this.settings.packGap, padding: this.settings.packPadding,
      strategy: this.settings.packStrategy, sortBy: this.settings.packSortBy, columns: this.settings.packColumns,
    };
    let packed = packLayout(fitted, packOpts);
    let edges = data.edges;
    if (edges.length > 0 && this.settings.optimizeEdges) {
      edges = optimizeEdges(packed, edges, this.settings.preserveAxes ? "preserve-axes" : "shortest");
    }
    const stats = packingStats(beforeNodes, packed);
    canvas.setData({ ...data, nodes: packed, edges });
    canvas.requestSave(false);
    new Notice(`Fit + Pack: ${packed.length} cards, saved ${stats.savedPct}% area`);
  }

  private async runFitAndGraphPack(canvas: Canvas): Promise<void> {
    const data = canvas.getData() as CanvasData;
    const beforeNodes = [...data.nodes];
    const domMap = buildDomMap(canvas);
    const fitOpts: FitOptions = {
      minHeight: this.settings.fitMinHeight, maxHeight: this.settings.fitMaxHeight,
      snapToGrid: this.settings.fitSnapToGrid, useDomWhenAvailable: true,
    };
    const { nodes: fitted } = fitAllNodes([...data.nodes], fitOpts, domMap);
    if (data.edges.length === 0) {
      // no edges → regular pack
      const packOpts: PackOptions = {
        ...DEFAULT_PACK_OPTIONS, gap: this.settings.packGap, padding: this.settings.packPadding,
        strategy: this.settings.packStrategy, sortBy: this.settings.packSortBy, columns: this.settings.packColumns,
      };
      const packed = packLayout(fitted, packOpts);
      const stats = packingStats(beforeNodes, packed);
      canvas.setData({ ...data, nodes: packed });
      canvas.requestSave(false);
      new Notice(`Fit + Pack (no edges): saved ${stats.savedPct}% area`);
      return;
    }
    const gOpts: PackOptions & { optimizeMode?: OptimizeMode; iterations?: number } = {
      ...DEFAULT_PACK_OPTIONS, gap: this.settings.packGap, padding: this.settings.packPadding,
      strategy: "maxrects", sortBy: this.settings.packSortBy, columns: this.settings.packColumns,
      optimizeMode: this.settings.preserveAxes ? "preserve-axes" : "shortest",
      iterations: this.settings.graphIterations,
    };
    const beforeLen = totalEdgeLength(beforeNodes, data.edges);
    const { nodes: packed, edges } = graphPack(fitted, [...data.edges], gOpts);
    const stats = packingStats(beforeNodes, packed);
    const afterLen = totalEdgeLength(packed, edges);
    canvas.setData({ ...data, nodes: packed, edges });
    canvas.requestSave(false);
    new Notice(`Fit + Graph Pack: ${packed.length} cards, ${edges.length} edges — saved ${stats.savedPct}% area, edges ${beforeLen}→${afterLen}px`);
  }

  private async runTidy(canvas: Canvas, preserveDirection: boolean): Promise<void> {
    const data = canvas.getData() as CanvasData;
    if (data.edges.length === 0) {
      new Notice("Tidy layout needs connections; this canvas has none.");
      return;
    }
    const gOpts: PackOptions & { optimizeMode?: OptimizeMode; iterations?: number } = {
      ...DEFAULT_PACK_OPTIONS, gap: this.settings.packGap, padding: this.settings.packPadding,
      strategy: "maxrects", sortBy: this.settings.packSortBy, columns: this.settings.packColumns,
      optimizeMode: this.settings.preserveAxes ? "preserve-axes" : "shortest",
      iterations: this.settings.graphIterations,
    };
    const beforeLen = totalEdgeLength(data.nodes, data.edges);
    const { nodes: tidied, edges } = tidyLayout([...data.nodes], [...data.edges], { ...gOpts, preserveDirection });
    const afterLen = totalEdgeLength(tidied, edges);
    canvas.setData({ ...data, nodes: tidied, edges });
    canvas.requestSave(false);
    new Notice(`Tidy layout${preserveDirection ? " (preserve direction)" : " (allow direction change)"}: ${tidied.length} cards, ${edges.length} edges — total edge length ${beforeLen}→${afterLen}px`);
  }

  // ── File (when canvas not open) ──
  private async fitAndPackFile(file: TFile): Promise<void> {
    const raw = await this.app.vault.cachedRead(file);
    let data: CanvasData;
    try { data = JSON.parse(raw) as CanvasData; } catch { new Notice("Invalid canvas file"); return; }
    if (data.edges.length > 0 && this.settings.optimizeEdges) {
      return this.fitAndGraphPackFile(file);
    }
    const beforeNodes = [...data.nodes];
    const fitOpts: FitOptions = {
      minHeight: this.settings.fitMinHeight, maxHeight: this.settings.fitMaxHeight,
      snapToGrid: this.settings.fitSnapToGrid, useDomWhenAvailable: false,
    };
    const { nodes: fitted } = fitAllNodes([...data.nodes], fitOpts);
    const packOpts: PackOptions = {
      ...DEFAULT_PACK_OPTIONS, gap: this.settings.packGap, padding: this.settings.packPadding,
      strategy: this.settings.packStrategy, sortBy: this.settings.packSortBy, columns: this.settings.packColumns,
    };
    const packed = packLayout(fitted, packOpts);
    let edges = data.edges;
    if (edges.length > 0 && this.settings.optimizeEdges) {
      edges = optimizeEdges(packed, edges, this.settings.preserveAxes ? "preserve-axes" : "shortest");
    }
    const stats = packingStats(beforeNodes, packed);
    data.nodes = packed; data.edges = edges;
    await this.app.vault.modify(file, JSON.stringify(data, null, 2));
    const view = getActiveCanvasView(this.app);
    if (view && view.file.path === file.path) { view.canvas.setData(data); view.canvas.requestSave(false); }
    new Notice(`Fit + Pack ${file.basename}: saved ${stats.savedPct}% area`);
  }

  private async fitAndGraphPackFile(file: TFile): Promise<void> {
    const raw = await this.app.vault.cachedRead(file);
    let data: CanvasData;
    try { data = JSON.parse(raw) as CanvasData; } catch { new Notice("Invalid canvas file"); return; }
    const beforeNodes = [...data.nodes];
    const fitOpts: FitOptions = {
      minHeight: this.settings.fitMinHeight, maxHeight: this.settings.fitMaxHeight,
      snapToGrid: this.settings.fitSnapToGrid, useDomWhenAvailable: false,
    };
    const { nodes: fitted } = fitAllNodes([...data.nodes], fitOpts);
    if (data.edges.length === 0) return this.fitAndPackFile(file);
    const gOpts: PackOptions & { optimizeMode?: OptimizeMode; iterations?: number } = {
      ...DEFAULT_PACK_OPTIONS, gap: this.settings.packGap, padding: this.settings.packPadding,
      strategy: "maxrects", sortBy: this.settings.packSortBy, columns: this.settings.packColumns,
      optimizeMode: this.settings.preserveAxes ? "preserve-axes" : "shortest",
      iterations: this.settings.graphIterations,
    };
    const beforeLen = totalEdgeLength(beforeNodes, data.edges);
    const { nodes: packed, edges } = graphPack(fitted, [...data.edges], gOpts);
    const stats = packingStats(beforeNodes, packed);
    const afterLen = totalEdgeLength(packed, edges);
    data.nodes = packed; data.edges = edges;
    await this.app.vault.modify(file, JSON.stringify(data, null, 2));
    const view = getActiveCanvasView(this.app);
    if (view && view.file.path === file.path) { view.canvas.setData(data); view.canvas.requestSave(false); }
    new Notice(`Fit + Graph Pack ${file.basename}: saved ${stats.savedPct}% area, edges ${beforeLen}→${afterLen}px`);
  }
}
