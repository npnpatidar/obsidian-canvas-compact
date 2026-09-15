import { Plugin, Notice, TFile, ItemView, Menu } from "obsidian";
import type { CanvasData, CanvasView, Canvas } from "./Canvas.d";
import { cleanLayout, describeCleanReport, DEFAULT_CLEAN_OPTIONS } from "./clean";
import { dagcolaLayout, DEFAULT_EXACT_DECROSS } from "./dagcola";
import type { CleanOptions, CleanDirection } from "./clean";

interface CanvasCompactSettings {
  cleanDirection: CleanDirection;
  cleanGap: number;
  cleanPadding: number;
  cleanReserveLabelSpace: boolean;
  // The crossing threshold applies to both engines; the key keeps its historic
  // `dagcola` prefix so existing saved settings keep loading.
  dagcolaExactDecrossThreshold: number;
  // dagcola (d3-dag + webcola) settings
  dagcolaEnabled: boolean;
  dagcolaUseColaRefinement: boolean;
  // Emit layout-engine diagnostics to the developer console.
  debug: boolean;
}

const DEFAULT_SETTINGS: CanvasCompactSettings = {
  cleanDirection: "top-to-bottom",
  cleanGap: 60,
  cleanPadding: 60,
  cleanReserveLabelSpace: true,
  dagcolaEnabled: false,
  dagcolaUseColaRefinement: true,
  dagcolaExactDecrossThreshold: DEFAULT_EXACT_DECROSS,
  debug: false,
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
  // The active file is a canvas but no matching view was reachable — either
  // Obsidian's internal API shifted or the view has not loaded yet. Surface it
  // loudly so an API break is diagnosed instead of silently failing the command.
  const active = app.workspace.getActiveFile();
  if (active && active.extension === "canvas" && app.workspace.getLeavesOfType("canvas").length > 0) {
    console.warn("[canvas-compact] active file is a canvas but no matching canvas view was found — the Obsidian Canvas API may have changed");
  }
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
      name: "DagCola layout — d3-dag + webcola",
      checkCallback: this.withCanvas((canvas) => this.runDagcola(canvas), true),
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
          if (this.settings.dagcolaEnabled) {
            (menu as Menu).addItem((item) =>
              item
                .setTitle("Canvas Compact: DagCola layout (d3-dag + webcola)")
                .setIcon("sparkles")
                .onClick(async () => { await this.dagcolaLayoutFile(file as TFile); })
            );
          }
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

  private withCanvas(fn: (canvas: Canvas) => void | Promise<void>, needsDagcola = false) {
    return (checking: boolean): boolean | void => {
      if (needsDagcola && !this.settings.dagcolaEnabled) {
        if (checking) return false;
        new Notice("Canvas Compact: enable \"DagCola layout\" in settings first.");
        return;
      }
      const view = getActiveCanvasView(this.app);
      if (!view) { if (checking) return false; new Notice("Open a canvas first."); return; }
      if (checking) return true;
      void fn(view.canvas);
    };
  }

  /**
   * Layout commands rewrite the user's canvas, so a failure must be visible
   * rather than an unhandled rejection that silently does nothing.
   */
  private async guarded(label: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      console.error(`[canvas-compact] ${label} failed`, error);
      new Notice(`Canvas Compact: ${label} failed — see the developer console for details.`);
    }
  }

  private cleanOptions(): CleanOptions {
    return {
      ...DEFAULT_CLEAN_OPTIONS,
      gap: this.settings.cleanGap,
      padding: this.settings.cleanPadding,
      direction: this.settings.cleanDirection,
      reserveLabelSpace: this.settings.cleanReserveLabelSpace,
      exactDecrossThreshold: this.settings.dagcolaExactDecrossThreshold,
      debug: this.settings.debug,
    };
  }

  private dagcolaOptions() {
    return {
      gap: this.settings.cleanGap,
      padding: this.settings.cleanPadding,
      direction: this.settings.cleanDirection,
      reserveLabelSpace: this.settings.cleanReserveLabelSpace,
      useColaRefinement: this.settings.dagcolaUseColaRefinement,
      exactDecrossThreshold: this.settings.dagcolaExactDecrossThreshold,
      debug: this.settings.debug,
    };
  }

  private async runClean(canvas: Canvas): Promise<void> {
    await this.guarded("Clean layout", async () => {
      const data = canvas.getData() as CanvasData;
      if (data.nodes.length === 0) { new Notice("Canvas is empty."); return; }
      const { nodes, edges, report } = cleanLayout([...data.nodes], [...data.edges], this.cleanOptions());
      canvas.setData({ ...data, nodes, edges });
      canvas.requestSave(false);
      new Notice(describeCleanReport(report));
    });
  }

  private async runDagcola(canvas: Canvas): Promise<void> {
    await this.guarded("DagCola layout", async () => {
      const data = canvas.getData() as CanvasData;
      if (data.nodes.length === 0) { new Notice("Canvas is empty."); return; }
      const { nodes, edges, report } = dagcolaLayout([...data.nodes], [...data.edges], this.dagcolaOptions());
      canvas.setData({ ...data, nodes, edges });
      canvas.requestSave(false);
      new Notice(describeCleanReport(report));
    });
  }

  // ── File (when canvas not open) ──
  private async cleanLayoutFile(file: TFile): Promise<void> {
    await this.guarded("Clean layout", async () => {
      const data = await this.readCanvasFile(file);
      if (!data) return;
      const { nodes, edges, report } = cleanLayout([...data.nodes], [...data.edges], this.cleanOptions());
      await this.writeCanvasFile(file, { ...data, nodes, edges });
      new Notice(describeCleanReport(report));
    });
  }

  private async dagcolaLayoutFile(file: TFile): Promise<void> {
    await this.guarded("DagCola layout", async () => {
      const data = await this.readCanvasFile(file);
      if (!data) return;
      const { nodes, edges, report } = dagcolaLayout([...data.nodes], [...data.edges], this.dagcolaOptions());
      await this.writeCanvasFile(file, { ...data, nodes, edges });
      new Notice(describeCleanReport(report));
    });
  }

  private async readCanvasFile(file: TFile): Promise<CanvasData | null> {
    const raw = await this.app.vault.cachedRead(file);
    try {
      return JSON.parse(raw) as CanvasData;
    } catch {
      new Notice("Invalid canvas file");
      return null;
    }
  }

  private async writeCanvasFile(file: TFile, data: CanvasData): Promise<void> {
    await this.app.vault.modify(file, JSON.stringify(data, null, 2));
    const view = getActiveCanvasView(this.app);
    if (view && view.file.path === file.path) { view.canvas.setData(data); view.canvas.requestSave(false); }
  }
}