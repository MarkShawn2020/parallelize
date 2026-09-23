import type { Lineage, LineageNode } from "./types";

const EMPTY: ReadonlySet<string> = new Set();

export class LineageGraph implements Lineage {
  private readonly nodes = new Map<string, LineageNode>();
  // Nodes are immutable once added, so root sets never change. Memo sets are shared, never mutated.
  private readonly rootsMemo = new Map<string, ReadonlySet<string>>();

  add(node: LineageNode): void {
    if (this.nodes.has(node.id)) throw new Error(`lineage: duplicate node ${node.id}`);
    for (const p of node.parents) {
      if (!this.nodes.has(p)) throw new Error(`lineage: unknown parent ${p} of ${node.id}`);
    }
    this.nodes.set(node.id, { ...node, parents: [...node.parents] });
  }

  get(id: string): LineageNode | undefined {
    return this.nodes.get(id);
  }

  roots(id: string): Set<string> {
    return new Set(this.rootSet(id));
  }

  independentSources(ids: string[]): number {
    const sets = ids.map((id) => this.rootSet(id));
    const parent = sets.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        const up = parent[i] as number;
        parent[i] = parent[up] as number;
        i = up;
      }
      return i;
    };
    const owner = new Map<string, number>();
    sets.forEach((set, i) => {
      for (const r of set) {
        const j = owner.get(r);
        if (j === undefined) owner.set(r, i);
        else parent[find(i)] = find(j);
      }
    });
    const groups = new Set<number>();
    // Task nodes have no roots and are not evidence, so they form no group.
    sets.forEach((set, i) => {
      if (set.size > 0) groups.add(find(i));
    });
    return groups.size;
  }

  isRecollision(id: string, cellId: string): boolean {
    const seen = new Set<string>();
    const stack = [...this.require(id).parents];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const node = this.require(cur);
      if (node.cellId === cellId) return true;
      stack.push(...node.parents);
    }
    return false;
  }

  private require(id: string): LineageNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`lineage: unknown node ${id}`);
    return node;
  }

  private cellParents(node: LineageNode): string[] {
    return node.parents.filter((p) => this.require(p).kind !== "task");
  }

  /** Iterative post-order so long proposal chains cannot overflow the call stack. */
  private rootSet(id: string): ReadonlySet<string> {
    this.require(id);
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack[stack.length - 1] as string;
      if (this.rootsMemo.has(cur)) {
        stack.pop();
        continue;
      }
      const node = this.require(cur);
      if (node.kind === "task") {
        this.rootsMemo.set(cur, EMPTY);
        stack.pop();
        continue;
      }
      const cellParents = this.cellParents(node);
      const pending = cellParents.filter((p) => !this.rootsMemo.has(p));
      if (pending.length > 0) {
        stack.push(...pending);
        continue;
      }
      this.rootsMemo.set(cur, this.combine(cur, cellParents));
      stack.pop();
    }
    return this.rootsMemo.get(id) as ReadonlySet<string>;
  }

  private combine(id: string, cellParents: string[]): ReadonlySet<string> {
    if (cellParents.length === 0) return new Set([id]);
    const parentSets = cellParents.map((p) => this.rootsMemo.get(p) as ReadonlySet<string>);
    if (parentSets.length === 1) return parentSets[0] as ReadonlySet<string>;
    const out = new Set<string>();
    for (const s of parentSets) for (const r of s) out.add(r);
    return out;
  }
}
