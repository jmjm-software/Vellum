import React, { useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { DashboardRenderer, WidgetMirror } from '@vellum/renderer';
import type { ActionSpec, DesignContent, Dataset, TargetKind } from '@vellum/core/types.js';

declare global {
  interface Window {
    __vellumActions: Array<{ action: ActionSpec; ctx: { componentId: string } }>;
    __vellumReady: boolean;
    /**
     * Spec injected by the preview worker before navigation (page.addInitScript).
     * Preferred over the query string: inlined assets make the spec far larger
     * than an HTTP header allows.
     */
    __vellumSpec?: RenderSpec;
  }
}

// Initialize the sandbox recorder eagerly so it exists even before mount.
window.__vellumActions = [];
window.__vellumReady = false;

interface RenderSpec {
  content: DesignContent;
  datasets: Dataset[];
  target: TargetKind;
  profile?: string;
  /** 'widget' renders the launcher-mirror view instead of the dashboard. */
  mode?: 'dashboard' | 'widget';
  /** Widget instance size in dp (mirror only). */
  widgetSize?: { width: number; height: number };
  /** assetId -> inlined data: URL, provided by the preview worker so screenshots
   *  show the real uploaded images without any network access. */
  assets?: Record<string, string>;
}

function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4)));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function parseSpec(): RenderSpec | null {
  // Injected out-of-band by the preview worker (no URL length limits).
  if (window.__vellumSpec) return window.__vellumSpec;
  // Fallbacks for manual debugging: ?spec=<base64url json> or window.name.
  try {
    const params = new URLSearchParams(window.location.search);
    const specParam = params.get('spec');
    if (specParam) return JSON.parse(decodeBase64Url(specParam)) as RenderSpec;
    if (window.name) return JSON.parse(window.name) as RenderSpec;
  } catch {
    return null;
  }
  return null;
}

function PreviewApp() {
  const spec = useMemo(() => parseSpec(), []);

  useEffect(() => {
    // Signal mount complete regardless of spec validity (worker waits on this).
    window.__vellumReady = true;
  }, []);

  const handleAction = useMemo(
    () => (action: ActionSpec, ctx: { componentId: string }) => {
      window.__vellumActions.push({ action, ctx });
    },
    []
  );

  if (!spec || !spec.content) {
    return (
      <div style={{ padding: 24, color: '#8a919c', fontFamily: 'system-ui, sans-serif' }}>
        Missing or invalid preview spec (window.__vellumSpec, ?spec=&lt;base64url json&gt; or window.name).
      </div>
    );
  }

  if (spec.mode === 'widget') {
    const size = spec.widgetSize ?? { width: 250, height: 140 };
    return (
      <div style={{ padding: 0, background: 'transparent' }}>
        <WidgetMirror
          widget={spec.content.widget ?? { components: [], datasets: [] }}
          datasets={spec.datasets ?? []}
          assets={spec.assets}
          width={size.width}
          height={size.height}
        />
      </div>
    );
  }

  return (
    <DashboardRenderer
      content={spec.content}
      datasets={spec.datasets ?? []}
      target={spec.target ?? 'desktop'}
      onAction={handleAction}
      assets={spec.assets}
      preview
    />
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<PreviewApp />);
