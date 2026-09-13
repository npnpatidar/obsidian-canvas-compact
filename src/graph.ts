/**
 * Small graph/geometry helpers shared by the layout engines.
 *
 * The two engines (Clean, DagCola) need the same primitives: cluster discovery,
 * side anchor points, and a segment/rectangle intersection test for the
 * crossing and visibility checks in `clean.ts`.
 */

import type { AllCanvasNodeData, CanvasEdgeData } from "./Canvas.d";

export type EdgeSide = "top" | "bottom" | "left" | "right";

/** Anchor point of an edge on the given side of a card. */
export function pointForSide(node: AllCanvasNodeData, side: EdgeSide): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

/** Does the segment (x1,y1)-(x2,y2) intersect the rectangle (rx,ry,rw,rh)? */
export function segmentIntersectsRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number
): boolean {
  const minX = Math.min(x1, x2),
    maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2),
    maxY = Math.max(y1, y2);
  if (maxX < rx || minX > rx + rw || maxY < ry || minY > ry + rh) return false;
  if (x1 >= rx && x1 <= rx + rw && y1 >= ry && y1 <= ry + rh) return true;
  if (x2 >= rx && x2 <= rx + rw && y2 >= ry && y2 <= ry + rh) return true;
  function ccw(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
    return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
  }
  function segI(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    dx: number,
    dy: number
  ): boolean {
    return (
      ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) &&
      ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy)
    );
  }
  const rx2 = rx + rw,
    ry2 = ry + rh;
  if (segI(x1, y1, x2, y2, rx, ry, rx2, ry)) return true;
  if (segI(x1, y1, x2, y2, rx2, ry, rx2, ry2)) return true;
  if (segI(x1, y1, x2, y2, rx2, ry2, rx, ry2)) return true;
  if (segI(x1, y1, x2, y2, rx, ry2, rx, ry)) return true;
  return false;
}

/**
 * Connected components of the undirected graph induced by `edges`. Cards with no
 * edges come back as singleton components.
 */
export function connectedComponents(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[]
): AllCanvasNodeData[][] {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    if (adj.has(e.fromNode) && adj.has(e.toNode)) {
      adj.get(e.fromNode)!.add(e.toNode);
      adj.get(e.toNode)!.add(e.fromNode);
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const comps: AllCanvasNodeData[][] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const stack = [n.id];
    const comp: AllCanvasNodeData[] = [];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(byId.get(id)!);
      for (const nb of adj.get(id) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}
