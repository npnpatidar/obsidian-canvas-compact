// Reverse-engineered + official canvas types (obsidian/canvas + live view)
export type CanvasColor = string;
export type NodeSide = "top" | "right" | "bottom" | "left";
export type EdgeEnd = "none" | "arrow";
export type BackgroundStyle = "cover" | "ratio" | "repeat";

export interface CanvasNodeData {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  [key: string]: unknown;
}

export interface CanvasFileData extends CanvasNodeData {
  type: "file";
  file: string;
  subpath?: string;
}

export interface CanvasTextData extends CanvasNodeData {
  type: "text";
  text: string;
  dynamicHeight?: boolean;
}

export interface CanvasLinkData extends CanvasNodeData {
  type: "link";
  url: string;
}

export interface CanvasGroupData extends CanvasNodeData {
  type: "group";
  label?: string;
  background?: string;
  backgroundStyle?: BackgroundStyle;
}

export type AllCanvasNodeData =
  | CanvasFileData
  | CanvasTextData
  | CanvasLinkData
  | CanvasGroupData;

export interface CanvasEdgeData {
  id: string;
  fromNode: string;
  fromSide?: NodeSide;
  fromEnd?: EdgeEnd;
  toNode: string;
  toSide?: NodeSide;
  toEnd?: EdgeEnd;
  color?: CanvasColor;
  label?: string;
  [key: string]: unknown;
}

export interface CanvasData {
  nodes: AllCanvasNodeData[];
  edges: CanvasEdgeData[];
  [key: string]: unknown;
}

// Live runtime (undocumented) — accessed via (view as CanvasView).canvas
export interface CanvasView {
  getViewType(): string;
  file: { path: string; extension: string; basename: string };
  canvas: Canvas;
  leaf: unknown;
}

export interface CanvasConfig {
  minContainerDimension: number;
}

export interface CanvasNode {
  id: string;
  canvas: Canvas;
  nodeEl: HTMLElement;
  x: number;
  y: number;
  width: number;
  height: number;
  getData(): CanvasNodeData;
  setData(data: Partial<CanvasNodeData>): void;
}

export interface Canvas {
  view: CanvasView;
  config: CanvasConfig;
  nodes: Map<string, CanvasNode>;
  selection: Set<CanvasNode>;
  getData(): CanvasData;
  setData(data: CanvasData): void;
  requestSave(save?: boolean): void;
  deselectAll(): void;
  select(node: CanvasNode): void;
  zoomToSelection(): void;
  readonly: boolean;
}
