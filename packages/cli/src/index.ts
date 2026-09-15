#!/usr/bin/env node
import process from "node:process";
import {
  getState,
  getDataset,
  getHealth,
  listRevisions,
  postEvents,
  postRollback,
  streamEvents,
  ApiError,
  type ApiConfig,
} from "./api.js";
import {
  formatStatus,
  formatDesignTree,
  formatDatasetList,
  formatDatasetDetail,
  formatEvents,
  formatHistory,
} from "./output.js";
import type { DashboardState } from "@vellum/core";

function help(): string {
  return `vellum CLI
Usage: vellum <command> [options]

Commands:
  status                         Show publication status
  design                         Show published design tree
  data list                      List datasets
  data get <id>                  Show dataset details
  events [--status <s>]          List events
  events ack <id> <success|failed>  Acknowledge an event
  history                        List publication revisions
  rollback <revision>            Rollback to a revision (agent token)
  watch                          Watch SSE stream

Options:
  --server <url>                 Vellum server URL (default: $VELLUM_SERVER or http://localhost:8787)
  --token <token>                Client token (default: $VELLUM_CLIENT_TOKEN)
  --agent-token <token>          Agent token (default: $VELLUM_AGENT_TOKEN)
`;
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = "true";
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function buildConfig(flags: Record<string, string>): { client: ApiConfig; agentToken: string } {
  const server = flags.server || process.env.VELLUM_SERVER || "http://localhost:8787";
  const token = flags.token || process.env.VELLUM_CLIENT_TOKEN || "client-dev-token";
  const agentToken = flags["agent-token"] || process.env.VELLUM_AGENT_TOKEN || "agent-dev-token";
  return { client: { server, token }, agentToken };
}

async function fetchPendingCount(
  client: ApiConfig,
  agentToken: string
): Promise<{ events: DashboardState["datasets"] | null; count: number | null }> {
  try {
    const res = await postEvents(
      { server: client.server, token: agentToken },
      { op: "list", status: "pending", limit: 100 }
    );
    if (res.events) {
      return { events: null, count: res.events.length };
    }
    return { events: null, count: null };
  } catch {
    return { events: null, count: null };
  }
}

async function run() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help || positional.length === 0) {
    console.log(help());
    process.exit(positional.length === 0 ? 1 : 0);
  }

  const { client, agentToken } = buildConfig(flags);
  const cmd = positional[0];

  try {
    switch (cmd) {
      case "status": {
        const state = await getState(client);
        const pending = await fetchPendingCount(client, agentToken);
        for (const line of formatStatus(state, pending.count !== null ? [] : null)) {
          console.log(line);
        }
        const health = await getHealth(client);
        if (health) {
          const sha = health.gitSha && health.gitSha !== "unknown" ? ` @${health.gitSha.slice(0, 7)}` : "";
          console.log(`Server build: version=${health.serverVersion ?? "?"}${sha} web=${health.web?.bundle ?? "?"}`);
        }
        break;
      }

      case "design": {
        const state = await getState(client);
        if (!state.publication) {
          console.log("No publication.");
          break;
        }
        for (const line of formatDesignTree(state.publication.content)) {
          console.log(line);
        }
        break;
      }

      case "data": {
        const sub = positional[1];
        if (sub === "list") {
          const state = await getState(client);
          for (const line of formatDatasetList(state.datasets)) {
            console.log(line);
          }
        } else if (sub === "get") {
          const id = positional[2];
          if (!id) {
            console.error("Usage: vellum data get <id>");
            process.exit(1);
          }
          try {
            const ds = await getDataset(client, id);
            for (const line of formatDatasetDetail(ds)) {
              console.log(line);
            }
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              console.error(`Dataset not found: ${id}`);
              process.exit(1);
            }
            throw err;
          }
        } else {
          console.error("Usage: vellum data list | vellum data get <id>");
          process.exit(1);
        }
        break;
      }

      case "events": {
        if (positional[1] === "ack") {
          const eventId = positional[2];
          const outcome = positional[3];
          if (!eventId || (outcome !== "success" && outcome !== "failed")) {
            console.error("Usage: vellum events ack <id> <success|failed>");
            process.exit(1);
          }
          const res = await postEvents(
            { server: client.server, token: agentToken },
            { op: "ack", eventId, outcome }
          );
          console.log(`Acknowledged ${res.event?.id ?? eventId}: ${outcome}`);
        } else {
          const status = flags.status;
          const res = await postEvents(
            { server: client.server, token: agentToken },
            { op: "list", status: status || undefined, limit: 100 }
          );
          for (const line of formatEvents(res.events ?? [])) {
            console.log(line);
          }
        }
        break;
      }

      case "history": {
        const revisions = await listRevisions(client);
        for (const line of formatHistory(revisions)) {
          console.log(line);
        }
        break;
      }

      case "rollback": {
        const revision = Number(positional[1]);
        if (!Number.isInteger(revision) || revision < 1) {
          console.error("Usage: vellum rollback <revision> (positive integer)");
          process.exit(1);
        }
        const result = await postRollback(
          { server: client.server, token: agentToken },
          revision
        );
        console.log("Rollback initiated:", JSON.stringify(result, null, 2));
        break;
      }

      case "watch": {
        console.log("Watching SSE stream. Press Ctrl+C to exit.");
        await streamEvents(
          client,
          (event, data) => {
            const ts = new Date().toISOString();
            console.log(`[${ts}] ${event}: ${JSON.stringify(data)}`);
          },
          (err) => {
            console.error("Stream error:", err.message);
            process.exit(1);
          }
        );
        break;
      }

      default: {
        console.error(`Unknown command: ${cmd}`);
        console.log(help());
        process.exit(1);
      }
    }
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

run();
