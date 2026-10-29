export interface DagJobInput {
  readonly id: number | undefined;
  readonly name: string;
  /** Parallel job group (`rspec 1/3` belongs to `rspec`); `needs` may reference the group name. */
  readonly group?: string;
  readonly status: string;
  readonly allowFailure?: boolean;
  readonly needs: readonly string[];
}

export interface DagStageInput {
  readonly name: string;
  readonly jobs: readonly DagJobInput[];
}

export interface DagNode {
  /** Job name (unique within a pipeline). */
  readonly key: string;
  readonly jobId: number | undefined;
  readonly name: string;
  readonly status: string;
  readonly allowFailure: boolean;
  readonly stage: string;
  readonly x: number;
  readonly y: number;
}

export interface DagEdge {
  readonly from: string;
  readonly to: string;
  /** SVG `<path>` element's `d` attribute. */
  readonly path: string;
}

export interface DagColumn {
  readonly stage: string;
  readonly x: number;
}

export interface DagLayout {
  readonly width: number;
  readonly height: number;
  readonly columns: readonly DagColumn[];
  readonly nodes: readonly DagNode[];
  readonly edges: readonly DagEdge[];
}

export const DAG_METRICS = {
  nodeWidth: 180,
  nodeHeight: 30,
  columnGap: 64,
  rowGap: 10,
  header: 28,
  padding: 12,
} as const;

/** Like GitLab's pipeline graph: one column per stage, edges based on `needs`. */
export function layoutDag(stages: readonly DagStageInput[]): DagLayout {
  const { nodeWidth: W, nodeHeight: H, columnGap: G, rowGap: R, header, padding: P } = DAG_METRICS;
  const visible = stages.filter((s) => s.jobs.length > 0);
  const columns: DagColumn[] = [];
  const nodes: DagNode[] = [];
  const groupOf = new Map<string, string>();
  visible.forEach((stage, col) => {
    const x = P + col * (W + G);
    columns.push({ stage: stage.name, x });
    stage.jobs.forEach((job, row) => {
      nodes.push({
        key: job.name,
        jobId: job.id,
        name: job.name,
        status: job.status,
        allowFailure: job.allowFailure ?? false,
        stage: stage.name,
        x,
        y: P + header + row * (H + R),
      });
      groupOf.set(job.name, job.group ?? job.name);
    });
  });
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const edges: DagEdge[] = [];
  const seen = new Set<string>();
  for (const stage of visible) {
    for (const job of stage.jobs) {
      const target = byKey.get(job.name);
      if (!target) continue;
      for (const need of job.needs) {
        for (const source of nodes) {
          if (source.key === target.key || (source.name !== need && groupOf.get(source.key) !== need)) continue;
          const id = `${source.key}->${target.key}`;
          if (seen.has(id)) continue;
          seen.add(id);
          edges.push({ from: source.key, to: target.key, path: edgePath(source, target) });
        }
      }
    }
  }
  const rows = Math.max(0, ...visible.map((s) => s.jobs.length));
  return {
    width: 2 * P + visible.length * W + Math.max(0, visible.length - 1) * G,
    height: 2 * P + header + rows * H + Math.max(0, rows - 1) * R,
    columns,
    nodes,
    edges,
  };
}

function edgePath(a: DagNode, b: DagNode): string {
  const { nodeWidth: W, nodeHeight: H } = DAG_METRICS;
  const x1 = a.x + W;
  const y1 = a.y + H / 2;
  const x2 = b.x;
  const y2 = b.y + H / 2;
  const dx = Math.max(24, (x2 - x1) / 2);
  return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
}
