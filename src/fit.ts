import type { AllCanvasNodeData, CanvasNodeData } from "./Canvas.d";

// ── Constants mirroring advanced-canvas ──
export const GRID_SIZE = 20;
export const DEFAULT_MIN_HEIGHT = 60;
export const DEFAULT_LINE_HEIGHT = 24; // px per text line in canvas node (incl. markdown spacing)
export const DEFAULT_H_PADDING = 16;   // inner padding top+bottom estimate
export const CHAR_PER_LINE_FUDGE = 2;  // safety lines

export interface FitOptions {
  minHeight: number;
  maxHeight: number; // -1 = unlimited
  snapToGrid: boolean;
  /** heuristic width for wrapping if no DOM available (node.width) */
  useDomWhenAvailable: boolean;
}

export const DEFAULT_FIT_OPTIONS: FitOptions = {
  minHeight: 60,
  maxHeight: -1,
  snapToGrid: true,
  useDomWhenAvailable: true,
};

// Strip markdown that affects length but not visual height too much
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^>\s+/gm, "");
}

/**
 * Heuristic: estimate height for a text node without DOM.
 * Uses word-wrapping simulation: assumes avg char width ~7px at canvas font size,
 * node width includes padding. More accurate than naive line count.
 */
export function estimateTextHeight(text: string, width: number): number {
  if (!text || text.trim().length === 0) return DEFAULT_MIN_HEIGHT;

  const innerWidth = Math.max(80, width - 24); // 12px side padding each
  const avgCharWidth = 7.2; // measured for Obsidian canvas text (~15px font)
  const charsPerLine = Math.max(10, Math.floor(innerWidth / avgCharWidth));

  const stripped = stripMarkdown(text);
  const rawLines = stripped.split("\n");

  let totalLines = 0;
  for (const raw of rawLines) {
    if (raw.trim() === "") {
      totalLines += 1; // blank line still takes height
      continue;
    }
    // wrap
    const len = raw.length;
    const wrapped = Math.max(1, Math.ceil(len / charsPerLine));
    totalLines += wrapped;
  }

  // markdown block spacing: headings/lists add a bit — add fudge per newline
  const newlineCount = (text.match(/\n/g) || []).length;
  const fudge = Math.min(3, Math.ceil(newlineCount / 3));

  const height = totalLines * DEFAULT_LINE_HEIGHT + DEFAULT_H_PADDING + fudge * 4;
  return Math.ceil(height);
}

/**
 * DOM measurement — exact, when live canvas is open.
 * Mirrors advanced-canvas: set height:min-content → read → restore.
 * Returns null if nodeEl / selectors not found.
 */
export function measureDomHeight(nodeEl: HTMLElement | null | undefined): number | null {
  if (!nodeEl) return null;

  // Try rendered preview first
  const preview = nodeEl.querySelector<HTMLElement>(".markdown-preview-view.markdown-rendered");
  if (preview) {
    const prev = preview.style.height;
    preview.style.height = "min-content";
    const h = preview.clientHeight;
    preview.style.height = prev;
    if (h > 0) return h;
  }

  // Fallback: CodeMirror scroller (editing mode)
  const scroller = nodeEl.querySelector<HTMLElement>(".cm-scroller");
  if (scroller) {
    const prev = scroller.style.height;
    scroller.style.height = "min-content";
    const h = scroller.scrollHeight;
    scroller.style.height = prev;
    if (h > 0) return h;
  }

  // Last resort: content container
  const content = nodeEl.querySelector<HTMLElement>(".canvas-node-content");
  if (content) {
    const prev = content.style.height;
    content.style.height = "min-content";
    const h = content.scrollHeight || content.clientHeight;
    content.style.height = prev;
    if (h > 0) return h;
  }

  return null;
}

export function applyConstraints(height: number, opts: FitOptions): number {
  if (height === 0) return 0;
  let h = height;
  if (opts.maxHeight !== -1 && h > opts.maxHeight) h = opts.maxHeight;
  h = Math.max(h, opts.minHeight);
  if (opts.snapToGrid) h = Math.ceil(h / GRID_SIZE) * GRID_SIZE;
  return h;
}

export function isFittableType(node: CanvasNodeData): boolean {
  if (node.type === "text") return true;
  if (node.type === "file") {
    const file = (node as AllCanvasNodeData & { file?: string }).file;
    return typeof file === "string" && file.endsWith(".md");
  }
  return false;
}

/**
 * Compute fitted height for a node data object.
 * If domMap provided, tries DOM exact first; else heuristic.
 */
export function fittedHeightForNode(
  node: AllCanvasNodeData,
  opts: FitOptions,
  domMap?: Map<string, HTMLElement>
): number | null {
  if (!isFittableType(node)) return null;

  let raw: number | null = null;

  if (opts.useDomWhenAvailable && domMap) {
    const el = domMap.get(node.id);
    raw = measureDomHeight(el ?? null);
  }

  if (raw == null || raw === 0) {
    if (node.type === "text") {
      raw = estimateTextHeight((node as { text: string }).text ?? "", node.width);
    } else if (node.type === "file") {
      // file nodes: title line + preview stub minimal; keep at least file node min
      const fileName = (node as { file: string }).file ?? "";
      // show filename only => 1 line, but keep existing height as floor
      raw = estimateTextHeight(fileName.split("/").pop() ?? "", node.width) + 8;
    } else {
      return null;
    }
  } else {
    // DOM gave us inner content height; add canvas node chrome padding
    raw = raw + 16; // border+padding compensation (observed in advanced-canvas)
  }

  const constrained = applyConstraints(raw, opts);
  // No-op check: if already within 4px, skip to reduce churn
  if (Math.abs(constrained - node.height) < 4) return null;
  return constrained;
}

/**
 * Batch: returns new nodes array with heights adjusted.
 * Keeps group/link/file(non-md) unchanged.
 */
export function fitAllNodes(
  nodes: AllCanvasNodeData[],
  opts: FitOptions = DEFAULT_FIT_OPTIONS,
  domMap?: Map<string, HTMLElement>
): { nodes: AllCanvasNodeData[]; changed: number; details: Array<{ id: string; from: number; to: number }> } {
  const details: Array<{ id: string; from: number; to: number }> = [];
  const out = nodes.map((n) => {
    const nh = fittedHeightForNode(n, opts, domMap);
    if (nh == null) return n;
    details.push({ id: n.id, from: n.height, to: nh });
    return { ...n, height: nh } as AllCanvasNodeData;
  });
  return { nodes: out, changed: details.length, details };
}
