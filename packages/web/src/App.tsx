import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardRenderer } from '@vellum/renderer';
import type { DashboardState, ActionSpec } from '@vellum/core/types.js';
import type { SubmitActionRequest, SubmitActionResult, StreamMessage } from '@vellum/core/protocol.js';

function getClientToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (token) {
    try { localStorage.setItem('vellum_client_token', token); } catch { /* ignore */ }
    return token;
  }
  try { return localStorage.getItem('vellum_client_token'); } catch { return null; }
}

function useApi(token: string | null) {
  const headers = useMemo(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }, [token]);

  const getState = useCallback(async (): Promise<{ state: DashboardState; offline: boolean }> => {
    const res = await fetch('/api/state', { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const offline = res.headers.get('x-vellum-offline') === '1';
    const state = (await res.json()) as DashboardState;
    // Report every fresh snapshot to the native shell (Android): it caches and
    // re-renders the launcher widget immediately — no 15-min wait, no extra
    // fetch. (Android shell also serves this payload offline via X-Vellum-Offline.)
    try {
      (window as unknown as { VellumBridge?: { postMessage: (s: string) => void } }).VellumBridge?.postMessage(
        JSON.stringify({ type: 'cacheState', json: JSON.stringify(state) })
      );
    } catch { /* bridge absent */ }
    return { state, offline };
  }, [headers]);

  const postAction = useCallback(async (body: SubmitActionRequest): Promise<SubmitActionResult> => {
    const res = await fetch('/api/actions', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<SubmitActionResult>;
  }, [headers]);

  /**
   * Uploaded assets are access-controlled, and an <img> tag cannot send an
   * Authorization header — so bytes are fetched with the client token and
   * handed to the renderer as an object URL.
   */
  const fetchAsset = useCallback(
    async (assetId: string): Promise<string> => {
      const res = await fetch(`/api/assets/${encodeURIComponent(assetId)}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return URL.createObjectURL(await res.blob());
    },
    [headers]
  );

  return { getState, postAction, fetchAsset };
}

/**
 * SSE via fetch (EventSource cannot send an Authorization header).
 * Parses `event:`/`data:` frames, calls onEvent for stream messages,
 * reconnects with exponential backoff (1s..30s), reports online/offline.
 */
function useStream(
  token: string | null,
  onEvent: (msg: StreamMessage) => void,
  onOnline: () => void,
  onOffline: () => void
) {
  const stopRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    stopRef.current = false;
    let backoff = 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function run() {
      while (!stopRef.current) {
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
          const res = await fetch('/api/stream', {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            signal: ctrl.signal,
          });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          backoff = 1000;
          onOnline();
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let eventName = 'message';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf('\n')) >= 0) {
              const raw = buf.slice(0, idx).replace(/\r$/, '');
              buf = buf.slice(idx + 1);
              if (raw === '') {
                eventName = 'message';
                continue;
              }
              if (raw.startsWith(':')) continue; // comment/ping
              if (raw.startsWith('event:')) {
                eventName = raw.slice(6).trim();
              } else if (raw.startsWith('data:')) {
                const data = raw.slice(5).trim();
                if (!data) continue;
                try {
                  const parsed = JSON.parse(data) as Partial<StreamMessage>;
                  onEvent({ event: (parsed.event ?? eventName) as StreamMessage['event'], id: parsed.id ?? '', data: parsed.data });
                } catch { /* ignore malformed frame */ }
              } else if (raw.startsWith('retry:')) {
                const n = Number(raw.slice(6).trim());
                if (Number.isFinite(n) && n > 0) backoff = Math.max(n, 500);
              }
            }
          }
        } catch {
          if (stopRef.current) return;
        }
        if (stopRef.current) return;
        onOffline();
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, backoff);
        });
        if (stopRef.current) return;
        backoff = Math.min(backoff * 2, 30_000);
      }
    }

    void run();
    return () => {
      stopRef.current = true;
      if (timer) clearTimeout(timer);
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
}

export default function App() {
  const token = useMemo(() => getClientToken(), []);
  const [offline, setOffline] = useState(false);
  const [stale, setStale] = useState(false);
  const [state, setState] = useState<DashboardState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const { getState, postAction, fetchAsset } = useApi(token);

  const [target, setTarget] = useState<'phone' | 'desktop'>(() =>
    window.innerWidth < 768 ? 'phone' : 'desktop'
  );
  useEffect(() => {
    const onResize = () => setTarget(window.innerWidth < 768 ? 'phone' : 'desktop');
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const fetchState = useCallback(async () => {
    try {
      const { state: s, offline } = await getState();
      setState(s);
      setOffline(offline);
      setStale(offline);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setStale(true);
    }
  }, [getState]);

  // Mark stale on any stream event, then refetch (§9: never imply an update before confirmation).
  const onStreamEvent = useCallback(
    (msg: StreamMessage) => {
      if (msg.event === 'publication' || msg.event === 'dataset' || msg.event === 'action') {
        setStale(true);
        void fetchState();
      }
    },
    [fetchState]
  );
  const onOnline = useCallback(() => setOffline(false), []);
  const onOffline = useCallback(() => {
    setOffline(true);
    setStale(true);
  }, []);
  useStream(token, onStreamEvent, onOnline, onOffline);

  useEffect(() => {
    void fetchState();
    // Android shell: dispatch after replaying a flushed offline queue (§9).
    const onRefresh = () => void fetchState();
    window.addEventListener('vellum:refresh', onRefresh);
    return () => window.removeEventListener('vellum:refresh', onRefresh);
  }, [fetchState]);

  const handleAction = useCallback(
    async (action: ActionSpec, ctx: { componentId: string }) => {
      // External links: never navigate the dashboard itself. On Android the
      // shell opens the system browser (bridge); in a browser we open a tab.
      if (action.kind === 'openUrl') {
        const href = action.href;
        if (!/^https?:\/\//i.test(href)) return; // defence in depth (server validated too)
        const bridge = (window as unknown as { VellumBridge?: { postMessage: (s: string) => void } }).VellumBridge;
        if (bridge) {
          bridge.postMessage(JSON.stringify({ type: 'openUrl', href }));
        } else {
          window.open(href, '_blank', 'noopener,noreferrer');
        }
        return;
      }

      const idKey = `${ctx.componentId}:${action.kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const body: SubmitActionRequest = {
        type:
          action.kind === 'toggleItem'
            ? 'toggleItem'
            : action.kind === 'event'
              ? action.type
              : 'openDashboard',
        datasetId: action.kind === 'toggleItem' ? action.dataset : '',
        itemId: action.kind === 'toggleItem' ? action.itemId : undefined,
        payload: action.kind === 'event' ? action.payload : undefined,
        idempotencyKey: idKey,
      };
      setPending((prev) => new Set(prev).add(ctx.componentId));
      setActionError(null);
      try {
        const result = await postAction(body);
        // Apply confirmed dataset locally if returned, then reconcile fully.
        if (result.dataset && state) {
          setState((prev) =>
            prev
              ? {
                  ...prev,
                  datasets: prev.datasets.map((d) => (d.id === result.dataset!.id ? result.dataset! : d)),
                }
              : prev
          );
        }
        await fetchState();
      } catch (err) {
        // Offline fallback: let the native shell queue the action locally and
        // replay it on reconnect (server dedupes by idempotencyKey, §9).
        const bridge = (window as unknown as { VellumBridge?: { postMessage: (s: string) => void } }).VellumBridge;
        if (bridge && (offline || err instanceof TypeError)) {
          bridge.postMessage(JSON.stringify({ type: 'queueAction', body }));
          setActionError('queued offline — will sync when back online');
        } else {
          setActionError(err instanceof Error ? err.message : String(err));
        }
        setStale(true);
        void fetchState();
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(ctx.componentId);
          return next;
        });
      }
    },
    [postAction, fetchState, state]
  );

  if (!token) {
    return (
      <div className="app-shell">
        <div className="app-message">
          Missing client token. Open with <code>?token=…</code> or set{' '}
          <code>localStorage.vellum_client_token</code>.
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="app-shell">
        <div className="app-message">
          {offline || loadError ? 'Offline — reconnecting…' : 'Loading…'}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-banner">
        <span className="app-title">
          Vellum {state.publication ? `· rev ${state.publication.revision}` : ''}
        </span>
        <span className="app-status">
          {offline && <span className="app-badge app-badge-offline">offline</span>}
          {stale && !offline && <span className="app-badge app-badge-stale">updating…</span>}
          {pending.size > 0 && (
            <span className="app-badge app-badge-pending">
              <span className="app-spinner" aria-hidden="true" /> {pending.size} pending
            </span>
          )}
          {actionError && <span className="app-badge app-badge-offline">action failed: {actionError}</span>}
        </span>
      </div>
      <div className="app-content">
        {state.publication ? (
          <DashboardRenderer
            content={state.publication.content}
            datasets={state.datasets}
            target={target}
            onAction={handleAction}
            fetchAsset={fetchAsset}
          />
        ) : (
          <div className="app-message">No publication yet — the agent hasn't published a design.</div>
        )}
      </div>
    </div>
  );
}
