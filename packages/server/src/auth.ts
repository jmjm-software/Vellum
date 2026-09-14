import type { Request, Response, NextFunction } from "express";

const clientToken = process.env.VELLUM_CLIENT_TOKEN ?? "client-dev-token";
const agentToken = process.env.VELLUM_AGENT_TOKEN ?? "agent-dev-token";

if (!process.env.VELLUM_CLIENT_TOKEN || !process.env.VELLUM_AGENT_TOKEN) {
  console.warn("[vellum-server] Using default dev tokens. Set VELLUM_CLIENT_TOKEN and VELLUM_AGENT_TOKEN for production.");
}

export function extractBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export function requireClientToken(req: Request, res: Response, next: NextFunction): void {
  const t = extractBearer(req);
  if (t !== clientToken) {
    res.status(401).json({ error: "unauthorized", message: "Invalid or missing client token" });
    return;
  }
  next();
}

export function requireAgentToken(req: Request, res: Response, next: NextFunction): void {
  const t = extractBearer(req);
  if (t !== agentToken) {
    res.status(401).json({ error: "unauthorized", message: "Invalid or missing agent token" });
    return;
  }
  next();
}

export function requireClientOrAgentToken(req: Request, res: Response, next: NextFunction): void {
  const t = extractBearer(req);
  if (t !== clientToken && t !== agentToken) {
    res.status(401).json({ error: "unauthorized", message: "Invalid or missing token" });
    return;
  }
  next();
}
