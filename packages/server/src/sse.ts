import type { Response } from "express";
import type { StreamEventName } from "@vellum/core/protocol.js";

export interface ClientConnection {
  id: string;
  res: Response;
}

class SSEManager {
  private clients = new Map<string, Response>();
  private idCounter = 0;

  add(res: Response): string {
    const id = String(++this.idCounter);
    this.clients.set(id, res);
    res.on("close", () => this.clients.delete(id));
    return id;
  }

  broadcast(event: StreamEventName, data: unknown): void {
    const payload = `event: ${event}\nid: ${Date.now()}\ndata: ${JSON.stringify(data)}\n\n`;
    const dead = new Set<string>();
    for (const [id, res] of this.clients) {
      if (res.writableEnded) {
        dead.add(id);
        continue;
      }
      try {
        res.write(payload);
      } catch {
        dead.add(id);
      }
    }
    for (const id of dead) this.clients.delete(id);
  }

  closeAll(): void {
    for (const res of this.clients.values()) {
      try { res.end(); } catch { /* noop */ }
    }
    this.clients.clear();
  }
}

export const sseManager = new SSEManager();
