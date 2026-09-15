import React from 'react';
// Import from the types subpath (not the package root): the root re-exports
// node-only modules (hashing) which bundlers cannot resolve for the browser.
import { WIDGET_LAYOUT } from '@vellum/core/types.js';
import type { Dataset, WidgetComponent, WidgetSpec } from '@vellum/core/types.js';

/**
 * Widget mirror: draws the launcher widget's presentation with plain DOM/CSS
 * using the shared layout tokens, so previews can be produced by the *existing*
 * Playwright worker on any architecture (no JDK, no Android SDK, no emulation —
 * matters on a Raspberry Pi, where the Android toolchain does not exist).
 *
 * This is a faithful-but-approximate mirror, not the native widget: the launcher
 * adds its own chrome (cell padding, corner masking, dynamic colors). The review
 * record marks mirror previews as such, and a native renderer (when attached)
 * supersedes them.
 */
export interface WidgetMirrorProps {
  widget: WidgetSpec;
  datasets: Dataset[];
  /** assetId -> URL (the worker inlines uploaded assets as data: URLs). */
  assets?: Record<string, string>;
  /** Widget instance size in dp (from the preview profile). */
  width: number;
  height: number;
}

const L = WIDGET_LAYOUT;

function budget(height: number): number {
  if (height < 130) return L.budget.under130;
  if (height < 200) return L.budget.under200;
  if (height < 300) return L.budget.under300;
  return L.budget.else;
}

export function WidgetMirror({ widget, datasets, assets = {}, width, height }: WidgetMirrorProps) {
  const compact = height < L.compactHeightBelow;
  const items = budget(height);
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const components = widget.components ?? [];
  const empty = components.length === 0;

  return (
    <div
      data-component-id="widget-root"
      className="widget-mirror"
      style={{
        width,
        height,
        boxSizing: 'border-box',
        background: L.colors.background,
        borderRadius: L.radius,
        padding: compact ? L.compactPadding : L.padding,
        display: 'flex',
        flexDirection: 'column',
        gap: L.gap,
        overflow: 'hidden',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {empty ? (
        <span style={{ color: L.colors.muted, fontSize: L.type.caption }}>
          Dashboard has no widget design yet
        </span>
      ) : (
        components.map((component, index) => {
          // Same rule as the native renderer: a tiny widget keeps the essentials.
          if (component.kind === 'action' && compact && items <= 2) return null;
          return (
            <WidgetComponentView
              key={`${index}-${component.kind}`}
              component={component}
              index={index}
              datasets={byId}
              assets={assets}
              items={items}
            />
          );
        })
      )}
    </div>
  );
}

function WidgetComponentView({
  component,
  index,
  datasets,
  assets,
  items,
}: {
  component: WidgetComponent;
  index: number;
  datasets: Map<string, Dataset>;
  assets: Record<string, string>;
  items: number;
}) {
  const id = `widget-${index}-${component.kind}`;
  const title = { color: L.colors.title, fontSize: L.type.title, fontWeight: 700 } as const;
  const body = { color: L.colors.body, fontSize: L.type.body } as const;
  const caption = { color: L.colors.muted, fontSize: L.type.caption } as const;
  const accent = { color: L.colors.accent, fontSize: L.type.body, fontWeight: 500 } as const;

  switch (component.kind) {
    case 'text': {
      const style =
        component.emphasis === 'title' ? title : component.emphasis === 'caption' ? caption : body;
      return (
        <div data-component-id={id} style={{ ...style, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {component.text}
        </div>
      );
    }

    case 'metric': {
      const dataset = datasets.get(component.dataset);
      const value =
        dataset?.value.kind === 'metric' ? dataset.value.values[component.field] : undefined;
      return (
        <div data-component-id={id} style={{ display: 'flex', flexDirection: 'column' }}>
          {component.label ? <div style={caption}>{component.label}</div> : null}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
            <span style={{ color: L.colors.title, fontSize: L.type.metric, fontWeight: 700 }}>
              {value === undefined ? '—' : formatNumber(value)}
            </span>
            {component.unit ? <span style={caption}>{component.unit}</span> : null}
          </div>
        </div>
      );
    }

    case 'list': {
      const dataset = datasets.get(component.dataset);
      const all = dataset?.value.kind === 'list' ? dataset.value.items : [];
      const visible = component.filter === 'unchecked' ? all.filter((i) => !i.done) : all;
      if (visible.length === 0) {
        return (
          <div data-component-id={id} style={caption}>
            {all.length > 0 ? 'All done' : 'Nothing here yet'}
          </div>
        );
      }
      const max = Math.min(component.maxItems ?? 4, items, visible.length);
      const remaining = visible.length - max;
      return (
        <div data-component-id={id} style={{ display: 'flex', flexDirection: 'column' }}>
          {visible.slice(0, max).map((item, i) => (
            <React.Fragment key={item.id}>
              {i > 0 ? (
                <div
                  style={{
                    height: L.dividerHeight,
                    background: L.colors.divider,
                    marginLeft: 0,
                  }}
                />
              ) : null}
              <div
                data-component-id={`${id}-row-${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  paddingTop: L.listRowPaddingY,
                  paddingBottom: L.listRowPaddingY,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}
              >
                <span
                  style={{
                    color: item.done ? L.colors.checked : L.colors.marker,
                    fontSize: L.type.body,
                    fontWeight: 700,
                  }}
                >
                  {item.done ? '✓' : '•'}
                </span>
                <span
                  style={{
                    color: item.done ? L.colors.done : L.colors.body,
                    fontSize: L.type.body,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {item.label}
                </span>
              </div>
            </React.Fragment>
          ))}
          {component.showRemainingCount && remaining > 0 ? (
            <div style={{ ...caption, paddingTop: 4 }}>+{remaining} more</div>
          ) : null}
        </div>
      );
    }

    case 'progress': {
      const dataset = datasets.get(component.dataset);
      const list = dataset?.value.kind === 'list' ? dataset.value.items : [];
      const done = list.filter((i) => i.done).length;
      const total = list.length;
      const blocks = 10;
      const filled = total > 0 ? Math.min(blocks, Math.round((done / total) * blocks)) : 0;
      return (
        <div data-component-id={id} style={{ display: 'flex', flexDirection: 'column' }}>
          {component.label ? <div style={caption}>{component.label}</div> : null}
          <div style={{ color: L.colors.title, fontSize: L.type.title, fontWeight: 700 }}>
            {done} / {total}
          </div>
          <div
            data-component-id={`${id}-bar`}
            style={{ color: L.colors.checked, fontSize: L.type.caption, whiteSpace: 'nowrap', overflow: 'hidden' }}
          >
            {'▰'.repeat(filled) + '▱'.repeat(blocks - filled)}
          </div>
        </div>
      );
    }

    case 'image': {
      const source = assets[component.assetId];
      const imageHeight = L.imageHeights[component.size ?? 'medium'] ?? L.imageHeights.medium;
      if (!source) {
        return (
          <div
            data-component-id={id}
            style={{
              height: 48,
              background: L.colors.placeholder,
              borderRadius: L.imageRadius,
              color: L.colors.muted,
              fontSize: L.type.caption,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            {component.alt ?? 'image'}
          </div>
        );
      }
      return (
        <img
          data-component-id={id}
          src={source}
          alt={component.alt ?? ''}
          style={{
            width: '100%',
            height: imageHeight,
            objectFit: 'contain',
            borderRadius: L.imageRadius,
          }}
        />
      );
    }

    case 'link':
      return <PillRow id={id} label={`${component.label} ↗`} style={accent} />;

    case 'action':
      return <PillRow id={id} label={component.label} style={accent} />;

    default:
      return null;
  }
}

function PillRow({
  id,
  label,
  style,
}: {
  id: string;
  label: string;
  style: React.CSSProperties;
}) {
  return (
    <div
      data-component-id={id}
      style={{
        background: L.colors.actionBackground,
        borderRadius: L.actionRadius,
        padding: '8px 10px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      <span style={style}>{label}</span>
    </div>
  );
}

function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
