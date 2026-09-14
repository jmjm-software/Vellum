import React, { useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { DashboardRenderer } from '@vellum/renderer';
import type { ActionSpec, DesignContent, Dataset, TargetKind } from '@vellum/core/types.js';

declare global {
  interface Window {
    __vellumActions: Array<{ action: ActionSpec; ctx: { componentId: string } }>;
    __vellumReady: boolean;
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
}

function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4)));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function parseSpec(): RenderSpec | null {
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
        Missing or invalid preview spec (?spec=&lt;base64url json&gt; or window.name).
      </div>
    );
  }

  return (
    <DashboardRenderer
      content={spec.content}
      datasets={spec.datasets ?? []}
      target={spec.target ?? 'desktop'}
      onAction={handleAction}
      preview
    />
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<PreviewApp />);
