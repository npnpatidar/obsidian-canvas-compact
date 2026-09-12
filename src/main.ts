import { Plugin, Notice, TFile, ItemView, Menu } from "obsidian";
import type { CanvasData, CanvasView, Canvas } from "./Canvas.d";
import { cleanLayout, describeCleanReport, DEFAULT_CLEAN_OPTIONS } from "./clean";
import { dagcolaLayout, dagcolaCleanLayout } from "./dagcola";
import type { CleanOptions, CleanDirection, CleanReport } from "./clean";

interface CanvasCompactSettings {
  cleanDirection: CleanDirection;
  cleanGap: number;
  cleanPadding: number;
  cleanReserveLabelSpace: boolean;
  // dagcola (d3-dag + webcola) settings
  dagcolaEnabled: boolean;
  dagcolaUseColaRefinement: boolean;
  dagcolaExactDecrossThreshold: number;
}

const DEFAULT_SETTINGS: CanvasCompactSettings = {
  cleanDirection: "top-to-bottom",
  cleanGap: 60,
  cleanPadding: 60,
  cleanReserveLabelSpace: true,
  dagcolaEnabled: false,
  dagcolaUseColaRefinement: true,
  dagcolaExactDecrossThreshold: 30,
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

export default class CanvasCompactPlugin extends Plugin {
  settings: CanvasCompactSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    const { CanvasCompactSettingTab } = await import("./settings");
    this.addSettingTab(new CanvasCompactSettingTab(this.app, this));

    this.addCommand({
      id: "canvas-compact-clean-layout",
      name: "Clean layout — no overlaps, minimal crossings",
      checkCallback: this.withCanvas((canvas) => this.runClean(canvas)),
    });

    this.addCommand({
      id: "canvas-compact-dagcola-layout",
      name: "DagCola layout — d3-dag + webcola (experimental)",
      checkCallback: this.withCanvas((canvas) => this.runDagcola(canvas)),
    });

    this.registerEvent(
      (this.app.workspace as unknown as { on: (ev: string, cb: (...args: unknown[]) => unknown) => { unload: () => void } }).on(
        "file-menu",
        (menu: unknown, file: unknown) => {
          if (!(file instanceof TFile) || !isCanvasFile(file)) return;
          (menu as Menu).addItem((item) =>
            item
              .setTitle("Canvas Compact: Clean layout (no overlaps)")
              .setIcon("sparkles")
              .onClick(async () => { await this.cleanLayoutFile(file as TFile); })
          );
          (menu as Menu).addItem((item) =>
            item
              .setTitle("Canvas Compact: DagCola layout (d3-dag + webcola)")
              .setIcon("sparkles")
              .onClick(async () => { await this.dagcolaLayoutFile(file as TFile); })
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

  private cleanOptions(): CleanOptions {
    return {
      ...DEFAULT_CLEAN_OPTIONS,
      gap: this.settings.cleanGap,
      padding: this.settings.cleanPadding,
      direction: this.settings.cleanDirection,
      reserveLabelSpace: this.settings.cleanReserveLabelSpace,
    };
  }

  private dagcolaOptions() {
    return {
      gap: this.settings.cleanGap,
      padding: this.settings.cleanPadding,
      direction: this.settings.cleanDirection,
      reserveLabelSpace: this.settings.cleanReserveLabelSpace,
      reduceCrossings: true,
      maxPasses: 40,
      useColaRefinement: this.settings.dagcolaUseColaRefinement,
      exactDecrossThreshold: this.settings.dagcolaExactDecrossThreshold,
    };
  }

  private async runClean(canvas: Canvas): Promise<void> {
    const data = canvas.getData() as CanvasData;
    if (data.nodes.length === 0) { new Notice("Canvas is empty."); return; }
    const { nodes, edges, report } = cleanLayout([...data.nodes], [...data.edges], this.cleanOptions());
    canvas.setData({ ...data, nodes, edges });
    canvas.requestSave(false);
    new Notice(describeCleanReport(report));
  }

  private async runDagcola(canvas: Canvas): Promise<void> {
    const data = canvas.getData() as CanvasData;
    if (data.nodes.length === 0) { new Notice("Canvas is empty."); return; }
    const { nodes, edges, report } = dagcolaLayout([...data.nodes], [...data.edges], this.dagcolaOptions());
    canvas.setData({ ...data, nodes, edges });
    canvas.requestSave(false);
    new Notice(describeCleanReport(report));
  }

  // ── File (when canvas not open) ──
  private async cleanLayoutFile(file: TFile): Promise<void> {
    const raw = await this.app.vault.cachedRead(file);
    let data: CanvasData;
    try { data = JSON.parse(raw) as CanvasData; } catch { new Notice("Invalid canvas file"); return; }
    const { nodes, edges, report } = cleanLayout([...data.nodes], [...data.edges], this.cleanOptions());
    data.nodes = nodes;
    data.edges = edges;
    await this.app.vault.modify(file, JSON.stringify(data, null, 2));
    const view = getActiveCanvasView(this.app);
    if (view && view.file.path === file.path) { view.canvas.setData(data); view.canvas.requestSave(false); }
    new Notice(describeCleanReport(report));
  }

  private async dagcolaLayoutFile(file: TFile): Promise<void> {
    const raw = await this.app.vault.cachedRead(file);
    let data: CanvasData;
    try { data = JSON.parse(raw) as CanvasData; } catch { new Notice("Invalid canvas file"); return; }
    const { nodes, edges, report } = dagcolaLayout([...data.nodes], [...data.edges], this.dagcolaOptions());
    data.nodes = nodes;
    data.edges = edges;
    await this.app.vault.modify(file, JSON.stringify(data, null, 2));
    const view = getActiveCanvasView(this.app);
    if (view && view.file.path === file.path) { view.canvas.setData(data); view.canvas.requestSave(false); }
    new Notice(describeCleanReport(report));
  }
}