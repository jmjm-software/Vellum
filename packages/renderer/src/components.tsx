import React, { useContext, useMemo, useState } from 'react';
import type {
  ComponentNode,
  Dataset,
  TargetKind,
  ActionSpec,
  DatasetValue,
  DesignContent,
} from '@vellum/core';

interface RendererContextValue {
  datasets: Map<string, Dataset>;
  target: TargetKind;
  onAction: (action: ActionSpec, ctx: { componentId: string }) => void;
  overrides: Map<string, { span?: number; order?: number; hidden?: boolean; compact?: boolean }>;
  preview: boolean;
  /** assetId -> URL (in previews: inlined data: URLs so screenshots show the real image). */
  assets: Map<string, string>;
}

const RendererContext = React.createContext<RendererContextValue>({
  datasets: new Map(),
  target: 'desktop',
  onAction: () => {},
  overrides: new Map(),
  preview: false,
  assets: new Map(),
});

function useRenderer() {
  return useContext(RendererContext);
}

function sortChildren(
  children: ComponentNode[],
  overrides: Map<string, { order?: number }>
): ComponentNode[] {
  // Components without an explicit order override keep their tree position;
  // explicit orders win. Ties break on original index (stable).
  return children
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const ao = overrides.get(a.node.id)?.order ?? a.index;
      const bo = overrides.get(b.node.id)?.order ?? b.index;
      return ao - bo || a.index - b.index;
    })
    .map((entry) => entry.node);
}

function ChildrenList({ nodes }: { nodes: ComponentNode[] }) {
  const { overrides } = useRenderer();
  const sorted = sortChildren(nodes, overrides);
  return (
    <>
      {sorted.map((child) => (
        <NodeRenderer key={child.id} node={child} />
      ))}
    </>
  );
}

function NodeRenderer({ node }: { node: ComponentNode }) {
  const { overrides } = useRenderer();
  const ov = overrides.get(node.id);
  if (ov?.hidden) return null;
  const compact = ov?.compact ? ' vellum-compact' : '';

  switch (node.type) {
    case 'grid':
      return <GridComponent node={node} />;
    case 'stack':
      return <StackComponent node={node} />;
    case 'section':
      return <SectionComponent node={node} compact={compact} />;
    case 'card':
      return <CardComponent node={node} compact={compact} />;
    case 'tabs':
      return <TabsComponent node={node} />;
    case 'checklist':
      return <ChecklistComponent node={node} compact={compact} />;
    case 'metric':
      return <MetricComponent node={node} compact={compact} />;
    case 'chart':
      return <ChartComponent node={node} />;
    case 'table':
      return <TableComponent node={node} compact={compact} />;
    case 'text':
      return <TextComponent node={node} compact={compact} />;
    case 'image':
      return <ImageComponent node={node} />;
    case 'link':
      return <LinkComponent node={node} />;
    case 'button':
      return <ButtonComponent node={node} />;
    default:
      return (
        <div data-component-id={node.id} className="vellum-unknown">
          Unknown {node.type}
        </div>
      );
  }
}

function GridComponent({ node }: { node: ComponentNode }) {
  const props = (node.props ?? {}) as { columns?: number; gap?: number };
  const columns = props.columns ?? 12;
  const gap = props.gap ?? 12;
  const { overrides } = useRenderer();
  const children = sortChildren(node.children ?? [], overrides);

  return (
    <div
      data-component-id={node.id}
      className="vellum-grid"
      style={{ '--columns': columns, gap } as React.CSSProperties}
    >
      {children.map((child) => {
        const span = overrides.get(child.id)?.span;
        return (
          <div
            key={child.id}
            style={{
              gridColumn: `span ${Math.min(Math.max(span ?? columns, 1), columns)}`,
              minWidth: 0,
            }}
          >
            <NodeRenderer node={child} />
          </div>
        );
      })}
    </div>
  );
}

function StackComponent({ node }: { node: ComponentNode }) {
  const props = (node.props ?? {}) as {
    direction?: 'vertical' | 'horizontal';
    gap?: number;
    align?: 'start' | 'center' | 'end' | 'stretch';
  };
  const dir = props.direction ?? 'vertical';
  const gap = props.gap ?? 8;
  const align = props.align ?? 'stretch';
  const cls = `vellum-stack vellum-stack-${dir}`;
  return (
    <div
      data-component-id={node.id}
      className={cls}
      style={{ gap, alignItems: align }}
    >
      <ChildrenList nodes={node.children ?? []} />
    </div>
  );
}

function SectionComponent({ node, compact = '' }: { node: ComponentNode; compact?: string }) {
  const props = (node.props ?? {}) as {
    title?: string;
    emphasis?: 'normal' | 'muted' | 'prominent';
  };
  return (
    <div
      data-component-id={node.id}
      className={`vellum-section vellum-section-${props.emphasis ?? 'normal'}${compact}`}
    >
      {props.title && <h3 className="vellum-section-title">{props.title}</h3>}
      <ChildrenList nodes={node.children ?? []} />
    </div>
  );
}

function CardComponent({ node, compact = '' }: { node: ComponentNode; compact?: string }) {
  const props = (node.props ?? {}) as {
    title?: string;
    emphasis?: 'normal' | 'muted' | 'prominent';
    density?: 'comfortable' | 'compact';
  };
  return (
    <div
      data-component-id={node.id}
      className={`vellum-card vellum-card-${props.emphasis ?? 'normal'} vellum-card-${
        props.density ?? 'comfortable'
      }${compact}`}
    >
      {props.title && <h3 className="vellum-card-title">{props.title}</h3>}
      <ChildrenList nodes={node.children ?? []} />
    </div>
  );
}

function TabsComponent({ node }: { node: ComponentNode }) {
  const props = (node.props ?? {}) as { labels?: Record<string, string> };
  const labels = props.labels ?? {};
  const children = node.children ?? [];
  const { overrides } = useRenderer();
  const sorted = sortChildren(children, overrides);

  const tabs: { label: string; items: ComponentNode[] }[] = [];
  const explicit: ComponentNode[] = [];
  const implicit: ComponentNode[] = [];

  for (const child of sorted) {
    if (labels[child.id]) explicit.push(child);
    else implicit.push(child);
  }

  for (const child of explicit) {
    tabs.push({ label: labels[child.id]!, items: [child] });
  }
  if (implicit.length > 0) {
    tabs.push({ label: 'More', items: implicit });
  }

  const [active, setActive] = useState(0);

  return (
    <div data-component-id={node.id} className="vellum-tabs">
      <div className="vellum-tab-list">
        {tabs.map((tab, i) => (
          <button
            key={tab.label + i}
            className={`vellum-tab ${i === active ? 'vellum-tab-active' : ''}`}
            onClick={() => setActive(i)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="vellum-tab-panel">
        {tabs[active]?.items.map((child) => (
          <NodeRenderer key={child.id} node={child} />
        ))}
      </div>
    </div>
  );
}

function ChecklistComponent({ node, compact = '' }: { node: ComponentNode; compact?: string }) {
  const props = (node.props ?? {}) as {
    dataset: string;
    maxVisible?: number;
    overflow?: 'showMore' | 'scroll' | 'paginate' | 'clip' | 'expand';
    showCompleted?: boolean;
    completedCollapsed?: boolean;
    emptyText?: string;
  };
  const { datasets, onAction } = useRenderer();
  const ds = datasets.get(props.dataset);
  const [limit, setLimit] = useState(props.maxVisible ?? 6);
  const [page, setPage] = useState(0);

  if (!ds || ds.schema.kind !== 'list') {
    return (
      <div data-component-id={node.id} className="vellum-empty">
        {props.emptyText ?? 'No items'}
      </div>
    );
  }

  let items = [
    ...(ds.value as Extract<DatasetValue, { kind: 'list' }>).items,
  ];
  if (props.showCompleted === false) {
    items = items.filter((i) => !i.done);
  }
  items.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));

  const maxVisible = props.maxVisible ?? 6;
  const overflow = props.overflow ?? 'showMore';

  let visibleItems = items;
  if (overflow === 'clip' || overflow === 'scroll') {
    visibleItems = items.slice(0, maxVisible);
  } else if (overflow === 'showMore' || overflow === 'expand') {
    visibleItems = items.slice(0, limit);
  } else if (overflow === 'paginate') {
    const start = page * maxVisible;
    visibleItems = items.slice(start, start + maxVisible);
  }

  const total = items.length;
  const empty = total === 0;

  return (
    <div data-component-id={node.id} className={`vellum-checklist${compact}`}>
      {empty && (
        <div className="vellum-empty">{props.emptyText ?? 'No items'}</div>
      )}
      <div
        className={overflow === 'scroll' ? 'vellum-overflow-scroll' : undefined}
        style={overflow === 'scroll' ? { maxHeight: maxVisible * 48 } : undefined}
      >
        {visibleItems.map((item) => (
          <div
            key={item.id}
            className="vellum-checklist-row"
            onClick={() =>
              onAction(
                { kind: 'toggleItem', dataset: props.dataset, itemId: item.id },
                { componentId: node.id }
              )
            }
          >
            <div
              className={`vellum-checklist-box ${
                item.done ? 'vellum-checklist-box-checked' : ''
              }`}
            >
              {item.done && <span>✓</span>}
            </div>
            <div
              className={`vellum-checklist-label ${
                item.done ? 'vellum-checklist-label-done' : ''
              }`}
            >
              {item.label}
            </div>
          </div>
        ))}
      </div>
      {overflow === 'showMore' && total > limit && (
        <button
          className="vellum-btn vellum-btn-secondary"
          onClick={() => setLimit((l) => l + maxVisible)}
        >
          Show more
        </button>
      )}
      {overflow === 'paginate' && total > maxVisible && (
        <div className="vellum-paginate">
          <button
            className="vellum-btn vellum-btn-secondary"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span>
            {page + 1} / {Math.ceil(total / maxVisible)}
          </span>
          <button
            className="vellum-btn vellum-btn-secondary"
            disabled={page >= Math.ceil(total / maxVisible) - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function MetricComponent({ node, compact = '' }: { node: ComponentNode; compact?: string }) {
  const props = (node.props ?? {}) as {
    dataset: string;
    field: string;
    label?: string;
    unit?: string;
    target?: number;
  };
  const { datasets } = useRenderer();
  const ds = datasets.get(props.dataset);
  if (!ds || ds.schema.kind !== 'metric') {
    return (
      <div data-component-id={node.id} className="vellum-empty">
        No data
      </div>
    );
  }
  const values = (ds.value as Extract<DatasetValue, { kind: 'metric' }>).values;
  const val = values[props.field] ?? 0;
  return (
    <div data-component-id={node.id} className={`vellum-metric${compact}`}>
      <div className="vellum-metric-label">{props.label || props.field}</div>
      <div className="vellum-metric-value">
        {val}
        {props.unit ? ` ${props.unit}` : ''}
      </div>
      {typeof props.target === 'number' && props.target > 0 && (
        <div className="vellum-metric-bar-bg">
          <div
            className="vellum-metric-bar-fill"
            style={{
              width: `${Math.min(100, (val / props.target) * 100)}%`,
            }}
          />
        </div>
      )}
    </div>
  );
}

const PALETTE = [
  '#4d8eff',
  '#3ccf4a',
  '#ff5a5a',
  '#f5a623',
  '#bd10e0',
  '#50e3c2',
];

function ChartComponent({ node }: { node: ComponentNode }) {
  const props = (node.props ?? {}) as {
    dataset: string;
    chartType: 'line' | 'bar';
    xField?: string;
    yFields: string[];
    title?: string;
    maxPoints?: number;
  };
  const { datasets } = useRenderer();
  const ds = datasets.get(props.dataset);

  if (!ds || ds.schema.kind !== 'timeseries') {
    return (
      <div data-component-id={node.id} className="vellum-empty">
        No data
      </div>
    );
  }

  const all = [
    ...(ds.value as Extract<DatasetValue, { kind: 'timeseries' }>).samples,
  ];
  all.sort((a, b) => a.t - b.t);
  const maxPoints = props.maxPoints ?? 500;
  const samples =
    all.length > maxPoints ? all.slice(all.length - maxPoints) : all;

  const yFields = props.yFields ?? [];
  if (yFields.length === 0) {
    return (
      <div data-component-id={node.id} className="vellum-empty">
        No fields
      </div>
    );
  }

  const W = 800;
  const H = 200;
  const mL = 48,
    mR = 16,
    mT = 16,
    mB = 32;
  const w = W - mL - mR;
  const h = H - mT - mB;

  const xs = samples.map((s) => s.t);
  const minX = xs[0] ?? 0;
  const maxX = xs[xs.length - 1] ?? minX + 1;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of samples) {
    for (const f of yFields) {
      const v = s.values[f];
      if (typeof v === 'number') {
        if (v < minY) minY = v;
        if (v > maxY) maxY = v;
      }
    }
  }
  if (!isFinite(minY)) {
    minY = 0;
    maxY = 1;
  }
  if (minY === maxY) maxY = minY + 1;

  const xScale = (t: number) =>
    mL + (maxX === minX ? 0 : (t - minX) / (maxX - minX)) * w;
  const yScale = (v: number) =>
    mT + h - ((v - minY) / (maxY - minY)) * h;

  const yTicks = 4;
  const yTickVals: number[] = [];
  for (let i = 0; i <= yTicks; i++) {
    yTickVals.push(minY + (maxY - minY) * (i / yTicks));
  }

  return (
    <div data-component-id={node.id} className="vellum-chart">
      {props.title && (
        <div className="vellum-chart-title">{props.title}</div>
      )}
      <svg
        className="vellum-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
      >
        {yTickVals.map((v, i) => (
          <g key={i}>
            <line
              x1={mL}
              y1={yScale(v)}
              x2={W - mR}
              y2={yScale(v)}
              stroke="var(--border)"
              strokeDasharray="2,2"
              opacity={0.5}
            />
            <text
              x={mL - 6}
              y={yScale(v)}
              fill="var(--text-muted)"
              fontSize={10}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {Number(v.toFixed(2))}
            </text>
          </g>
        ))}
        <line
          x1={mL}
          y1={mT + h}
          x2={W - mR}
          y2={mT + h}
          stroke="var(--border)"
        />
        <line
          x1={mL}
          y1={mT}
          x2={mL}
          y2={mT + h}
          stroke="var(--border)"
        />

        {props.chartType === 'line'
          ? yFields.map((field, fi) => {
              let d = '';
              for (let i = 0; i < samples.length; i++) {
                const x = xScale(samples[i].t);
                const v = samples[i].values[field];
                const y = yScale(typeof v === 'number' ? v : minY);
                d += `${i === 0 ? 'M' : 'L'}${x},${y} `;
              }
              return (
                <path
                  key={field}
                  d={d}
                  fill="none"
                  stroke={PALETTE[fi % PALETTE.length]}
                  strokeWidth={2}
                />
              );
            })
          : yFields.map((field, fi) => {
              const band = samples.length > 0 ? w / samples.length : w;
              const barW = (band / yFields.length) * 0.8;
              return samples.map((s, si) => {
                const v = s.values[field];
                if (typeof v !== 'number') return null;
                const x =
                  mL +
                  si * band +
                  fi * barW +
                  (band - yFields.length * barW) / 2;
                const y = yScale(v);
                const height = mT + h - y;
                return (
                  <rect
                    key={`${field}-${si}`}
                    x={x}
                    y={y}
                    width={barW}
                    height={height}
                    fill={PALETTE[fi % PALETTE.length]}
                  />
                );
              });
            })}
      </svg>
    </div>
  );
}

function TableComponent({ node, compact = '' }: { node: ComponentNode; compact?: string }) {
  const props = (node.props ?? {}) as {
    dataset: string;
    columns?: string[];
    maxRows?: number;
    overflow?: 'showMore' | 'scroll' | 'paginate' | 'clip' | 'expand';
  };
  const { datasets } = useRenderer();
  const ds = datasets.get(props.dataset);
  const [limit, setLimit] = useState(props.maxRows ?? 50);
  const [page, setPage] = useState(0);

  if (!ds || ds.schema.kind !== 'records') {
    return (
      <div data-component-id={node.id} className="vellum-empty">
        No data
      </div>
    );
  }

  const rows = (ds.value as Extract<DatasetValue, { kind: 'records' }>).rows;
  const schemaCols = (
    ds.schema as Extract<import('@vellum/core').DatasetSchema, { kind: 'records' }>
  ).columns;
  const columns = props.columns ?? schemaCols.map((c) => c.name);
  const maxRows = props.maxRows ?? 50;
  const overflow = props.overflow ?? 'showMore';

  let displayRows = rows;
  if (overflow === 'clip' || overflow === 'scroll') {
    displayRows = rows.slice(0, maxRows);
  } else if (overflow === 'showMore' || overflow === 'expand') {
    displayRows = rows.slice(0, limit);
  } else if (overflow === 'paginate') {
    const start = page * maxRows;
    displayRows = rows.slice(start, start + maxRows);
  }

  return (
    <div data-component-id={node.id} className={`vellum-table-root${compact}`}>
      <div
        className={
          overflow === 'scroll'
            ? 'vellum-table-wrap vellum-overflow-scroll'
            : 'vellum-table-wrap'
        }
        style={overflow === 'scroll' ? { maxHeight: maxRows * 40 } : undefined}
      >
        <table className="vellum-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c}>{row[c] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <div className="vellum-empty">No rows</div>}
      {overflow === 'showMore' && rows.length > limit && (
        <button
          className="vellum-btn vellum-btn-secondary"
          onClick={() => setLimit((l) => l + maxRows)}
        >
          Show more
        </button>
      )}
      {overflow === 'paginate' && rows.length > maxRows && (
        <div className="vellum-paginate">
          <button
            className="vellum-btn vellum-btn-secondary"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span>
            {page + 1} / {Math.ceil(rows.length / maxRows)}
          </span>
          <button
            className="vellum-btn vellum-btn-secondary"
            disabled={page >= Math.ceil(rows.length / maxRows) - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function TextComponent({ node, compact = '' }: { node: ComponentNode; compact?: string }) {
  const props = (node.props ?? {}) as {
    content: string;
    style?: 'body' | 'caption' | 'heading';
  };
  const style = props.style ?? 'body';
  return (
    <div
      data-component-id={node.id}
      className={`vellum-text vellum-text-${style}${compact}`}
    >
      {props.content}
    </div>
  );
}

function ImageComponent({ node }: { node: ComponentNode }) {
  const props = (node.props ?? {}) as {
    assetId: string;
    alt?: string;
    fit?: 'contain' | 'cover';
    action?: ActionSpec;
  };
  const { preview, assets, onAction } = useRenderer();
  const fit = props.fit ?? 'contain';
  const resolved = assets.get(props.assetId);
  // In previews only inlined assets render (no network); otherwise the
  // access-controlled endpoint serves the uploaded bytes.
  const src = resolved ?? (preview ? undefined : `/api/assets/${props.assetId}`);

  const body = src ? (
    <img
      data-component-id={node.id}
      className="vellum-image"
      src={src}
      alt={props.alt ?? ''}
      style={{ objectFit: fit }}
    />
  ) : (
    <div data-component-id={node.id} className="vellum-image-placeholder" style={{ objectFit: fit }}>
      Image
    </div>
  );

  // Images may carry a click behavior (e.g. view full size, open a page).
  if (props.action) {
    return (
      <button
        type="button"
        className="vellum-image-button"
        onClick={() => onAction(props.action!, { componentId: node.id })}
        aria-label={props.alt ?? 'image action'}
      >
        {body}
      </button>
    );
  }
  return body;
}

/**
 * External link. Rendered as a button, never a raw anchor: the client decides
 * how to open the URL (system browser on Android, new tab on web), so previews
 * and the WebView shell never navigate away on their own. http(s) only — the
 * href was validated server-side against a scheme allowlist.
 */
function LinkComponent({ node }: { node: ComponentNode }) {
  const props = (node.props ?? {}) as {
    label: string;
    href: string;
    description?: string;
    style?: 'body' | 'caption' | 'heading';
  };
  const { onAction } = useRenderer();
  const style = props.style ?? 'body';
  return (
    <div data-component-id={node.id} className={`vellum-link vellum-text-${style}`}>
      <button
        type="button"
        className="vellum-link-target"
        onClick={() => onAction({ kind: 'openUrl', href: props.href }, { componentId: node.id })}
        title={props.href}
      >
        {props.label}
        <span className="vellum-link-external" aria-hidden="true">
          {' '}
          ↗
        </span>
      </button>
      {props.description ? <div className="vellum-link-description">{props.description}</div> : null}
    </div>
  );
}

function ButtonComponent({ node }: { node: ComponentNode }) {
  const props = (node.props ?? {}) as {
    label: string;
    action: ActionSpec;
    variant?: 'primary' | 'secondary' | 'danger';
  };
  const { onAction } = useRenderer();
  const variant = props.variant ?? 'secondary';
  return (
    <button
      data-component-id={node.id}
      className={`vellum-btn vellum-btn-${variant}`}
      onClick={() => onAction(props.action, { componentId: node.id })}
    >
      {props.label}
    </button>
  );
}

export interface DashboardRendererProps {
  content: DesignContent;
  datasets: Dataset[];
  target: TargetKind;
  onAction: (action: ActionSpec, ctx: { componentId: string }) => void;
  width?: number;
  preview?: boolean;
  /** assetId -> URL (previews pass inlined data: URLs so screenshots show images). */
  assets?: Record<string, string>;
}

export function DashboardRenderer({
  content,
  datasets,
  target,
  onAction,
  width,
  preview = false,
  assets,
}: DashboardRendererProps) {
  const overrides = useMemo(() => {
    const map = new Map<
      string,
      { span?: number; order?: number; hidden?: boolean; compact?: boolean }
    >();
    const targetMap = content.overrides?.[target] ?? {};
    for (const [id, override] of Object.entries(targetMap)) {
      if (override) map.set(id, override);
    }
    return map;
  }, [content.overrides, target]);

  const dsMap = useMemo(() => {
    const map = new Map<string, Dataset>();
    for (const ds of datasets) map.set(ds.id, ds);
    return map;
  }, [datasets]);

  const assetMap = useMemo(() => new Map(Object.entries(assets ?? {})), [assets]);

  return (
    <RendererContext.Provider
      value={{ datasets: dsMap, target, onAction, overrides, preview, assets: assetMap }}
    >
      <div
        className="vellum-root"
        style={{ width: width !== undefined ? width : undefined }}
      >
        <NodeRenderer node={content.root} />
      </div>
    </RendererContext.Provider>
  );
}
