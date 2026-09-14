import type {
  DashboardState,
  Dataset,
  ActionEvent,
  Publication,
} from "@vellum/core";

export interface ApiConfig {
  server: string;
  token: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(config: ApiConfig, method: string, path: string, body?: unknown): Promise<T> {
  const url = `${config.server.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let message = await res.text().catch(() => "");
      try {
        const json = JSON.parse(message) as { message?: string; error?: string };
        message = json.message || json.error || message;
      } catch {
        // ignore parse error, use raw body
      }
      if (res.status === 401) {
        message = message || "Unauthorized: invalid token";
      } else if (res.status === 403) {
        message = message || "Forbidden: agent token may be required";
      } else if (res.status === 404) {
        message = message || `Not found: ${path}`;
      } else if (res.status === 409) {
        message = message || "Conflict: version mismatch or duplicate";
      } else if (res.status === 0) {
        message = "Connection failed";
      }
      throw new ApiError(res.status, message || `HTTP ${res.status}`);
    }
    // Empty body for some endpoints
    const text = await res.text();
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, err instanceof Error ? err.message : String(err));
  }
}

export async function getState(config: ApiConfig): Promise<DashboardState> {
  return request<DashboardState>(config, "GET", "/api/state");
}

export async function getDataset(config: ApiConfig, id: string): Promise<Dataset> {
  return request<Dataset>(config, "GET", `/api/datasets/${encodeURIComponent(id)}`);
}

export interface RevisionSummary {
  revision: number;
  draftId: string;
  publishedAt: number;
  reviewId: string;
}

export async function listRevisions(config: ApiConfig): Promise<RevisionSummary[]> {
  const res = await request<{ revisions: RevisionSummary[] }>(config, "GET", "/api/history");
  return res.revisions ?? [];
}

export async function postEvents(
  config: ApiConfig,
  body: unknown
): Promise<{ op: string; events?: ActionEvent[]; event?: ActionEvent }> {
  return request<{ op: string; events?: ActionEvent[]; event?: ActionEvent }>(config, "POST", "/api/agent/events", body);
}

export async function postData(config: ApiConfig, body: unknown): Promise<unknown> {
  return request(config, "POST", "/api/agent/data", body);
}

export async function postRollback(config: ApiConfig, revision: number): Promise<unknown> {
  return request(config, "POST", "/api/agent/rollback", { revision });
}

export async function streamEvents(
  config: ApiConfig,
  onEvent: (event: string, data: unknown) => void,
  onError: (err: Error) => void
): Promise<void> {
  const url = `${config.server.replace(/\/$/, "")}/api/stream`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "text/event-stream",
      },
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new ApiError(res.status, `SSE stream failed: ${body}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "message";
    let currentData = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const chunk = line.slice(5).trim();
          currentData += (currentData ? "\n" : "") + chunk;
        } else if (line === "" || line === "\r") {
          if (currentData) {
            try {
              const parsed = JSON.parse(currentData);
              onEvent(currentEvent, parsed);
            } catch {
              onEvent(currentEvent, currentData);
            }
            currentData = "";
            currentEvent = "message";
          }
        }
      }
    }
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}
