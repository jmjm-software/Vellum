import type {
  DashboardState,
  Dataset,
  ActionEvent,
  Publication,
  DesignContent,
  ComponentNode,
  TargetKind,
} from "@vellum/core";

function tableLines(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) {
    return [headers.join("  ")];
  }
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (s: string, w: number) => s.padEnd(w, " ");
  const lines: string[] = [];
  lines.push(headers.map((h, i) => pad(h, widths[i])).join("  "));
  for (const row of rows) {
    lines.push(row.map((cell, i) => pad(cell, widths[i])).join("  "));
  }
  return lines;
}

function datasetSummaryCount(ds: Dataset): string {
  switch (ds.value.kind) {
    case "list":
      return `${ds.value.items.length} items`;
    case "metric":
      return `${Object.keys(ds.value.values).length} fields`;
    case "timeseries":
      return `${ds.value.samples.length} samples`;
    case "records":
      return `${ds.value.rows.length} rows`;
    default:
      return "";
  }
}

export function formatStatus(state: DashboardState, pendingEvents: ActionEvent[] | null): string[] {
  const lines: string[] = [];
  if (state.publication) {
    lines.push(`Publication: revision ${state.publication.revision}`);
    lines.push(`PublishedAt: ${new Date(state.publication.publishedAt).toISOString()}`);
    lines.push(`ContentHash: ${state.publication.contentHash}`);
  } else {
    lines.push("Publication: none");
  }
  lines.push(`ServerTime: ${new Date(state.serverTime).toISOString()}`);
  lines.push(`Datasets: ${state.datasets.length}`);
  for (const ds of state.datasets) {
    lines.push(`  ${ds.id} — ${ds.title} (${ds.ownership}, ${ds.schema.kind}) — ${datasetSummaryCount(ds)}`);
  }
  if (pendingEvents !== null) {
    lines.push(`Pending events: ${pendingEvents.length}${pendingEvents.length >= 100 ? "+" : ""}`);
  } else {
    lines.push("Pending events: —");
  }
  return lines;
}

export function formatDesignTree(content: DesignContent): string[] {
  const lines: string[] = [];
  const overrides = content.overrides ?? {};

  function nodeLabel(node: ComponentNode): string {
    const parts: string[] = [node.id, `(${node.type})`];
    const targetNotes: string[] = [];
    for (const target of ["phone", "desktop", "widget"] as TargetKind[]) {
      const ov = overrides[target]?.[node.id];
      if (!ov) continue;
      const bits: string[] = [];
      if (ov.span) bits.push(`span=${ov.span}`);
      if (ov.hidden) bits.push("hidden");
      if (ov.compact) bits.push("compact");
      if (typeof ov.order === "number") bits.push(`order=${ov.order}`);
      if (bits.length) targetNotes.push(`${target}: ${bits.join(",")}`);
    }
    if (targetNotes.length) parts.push(`[${targetNotes.join("; ")}]`);
    if (node.props && typeof node.props === "object") {
      const p = node.props as Record<string, unknown>;
      if (typeof p.dataset === "string") parts.push(`dataset="${p.dataset}"`);
      if (typeof p.field === "string") parts.push(`field="${p.field}"`);
      if (typeof p.label === "string" && p.label.length < 30) parts.push(`label="${p.label}"`);
      if (typeof p.content === "string" && p.content.length < 40) {
        parts.push(`content="${p.content.slice(0, 35)}${p.content.length > 35 ? "…" : ""}"`);
      }
      if (typeof p.chartType === "string") parts.push(`chartType="${p.chartType}"`);
      if (typeof p.action === "object" && p.action !== null) {
        const a = p.action as { kind: string };
        parts.push(`action=${a.kind}`);
      }
    }
    return parts.join(" ");
  }

  function walk(node: ComponentNode, prefix: string, isLast: boolean) {
    const branch = prefix + (isLast ? "└── " : "├── ");
    lines.push(branch + nodeLabel(node));
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      walk(children[i] as ComponentNode, childPrefix, i === children.length - 1);
    }
  }

  walk(content.root, "", true);

  // The launcher widget is a separate compact presentation: images/components
  // from the main tree appear there only if the widget spec includes them.
  lines.push("");
  const widget = content.widget;
  if (widget && widget.components.length > 0) {
    lines.push("Widget presentation (launcher):");
    for (const c of widget.components) {
      let detail = "";
      if (c.kind === "text") detail = ` "${c.text}"`;
      else if (c.kind === "metric") detail = ` dataset="${c.dataset}" field="${c.field}"`;
      else if (c.kind === "list") detail = ` dataset="${c.dataset}" maxItems=${c.maxItems ?? 4}${c.filter ? ` filter=${c.filter}` : ""}`;
      else if (c.kind === "progress") detail = ` dataset="${c.dataset}"`;
      else if (c.kind === "image") detail = ` assetId="${c.assetId}"`;
      else if (c.kind === "link") detail = ` "${c.label}" -> ${c.href}`;
      else if (c.kind === "action") detail = ` "${c.label}" action=${c.action?.kind}`;
      lines.push(`  ${c.kind}${detail}`);
    }
    lines.push(`  datasets: ${widget.datasets.join(", ") || "(none)"}`);
  } else {
    lines.push("Widget presentation (launcher): none designed — the widget falls back to a starter view");
  }
  return lines;
}

export function formatDatasetList(datasets: Dataset[]): string[] {
  if (datasets.length === 0) return ["No datasets."];
  const headers = ["ID", "TITLE", "OWNERSHIP", "KIND", "COUNT"];
  const rows = datasets.map((ds) => [
    ds.id,
    ds.title,
    ds.ownership,
    ds.schema.kind,
    datasetSummaryCount(ds),
  ]);
  return tableLines(headers, rows);
}

export function formatDatasetDetail(ds: Dataset): string[] {
  const lines: string[] = [];
  lines.push(`Dataset: ${ds.id}`);
  lines.push(`Title: ${ds.title}`);
  lines.push(`Ownership: ${ds.ownership}`);
  lines.push(`Schema: ${ds.schema.kind}`);
  lines.push(`Version: ${ds.version}`);
  lines.push(`Updated: ${new Date(ds.updatedAt).toISOString()}`);
  lines.push("");

  switch (ds.value.kind) {
    case "list": {
      if (ds.value.items.length === 0) {
        lines.push("Items: (empty)");
      } else {
        lines.push("Items:");
        for (const it of ds.value.items) {
          const mark = it.done ? "[x]" : "[ ]";
          lines.push(`  ${mark} ${it.label}`);
        }
      }
      break;
    }
    case "metric": {
      lines.push("Values:");
      for (const [k, v] of Object.entries(ds.value.values)) {
        lines.push(`  ${k}: ${v}`);
      }
      break;
    }
    case "timeseries": {
      const series =
        ds.schema.kind === "timeseries"
          ? ds.schema.series.map((s) => s.name)
          : Object.keys(ds.value.samples[0]?.values ?? {});
      lines.push(`Samples: ${ds.value.samples.length}`);
      const head = ds.value.samples.slice(0, 20);
      for (const s of head) {
        const parts = series.map((name) => `${name}=${s.values[name] ?? "-"}`);
        lines.push(`  ${new Date(s.t).toISOString()}  ${parts.join("  ")}`);
      }
      if (ds.value.samples.length > 20) {
        lines.push(`  ... (${ds.value.samples.length - 20} more)`);
      }
      break;
    }
    case "records": {
      const cols =
        ds.schema.kind === "records"
          ? ds.schema.columns.map((c) => c.name)
          : Object.keys(ds.value.rows[0] ?? {});
      lines.push("Columns: " + cols.join(", "));
      lines.push("");
      const head = ds.value.rows.slice(0, 20);
      for (const row of head) {
        const cells = cols.map((c) => `${row[c] ?? "-"}`);
        lines.push("  " + cells.join("  "));
      }
      if (ds.value.rows.length > 20) {
        lines.push(`  ... (${ds.value.rows.length - 20} more rows)`);
      }
      break;
    }
  }
  return lines;
}

export function formatEvents(events: ActionEvent[]): string[] {
  if (events.length === 0) return ["No events."];
  const headers = ["ID", "TYPE", "STATUS", "DATASET", "ITEM", "CREATED"];
  const rows = events.map((e) => [
    e.id,
    e.type,
    e.status,
    e.datasetId || "",
    e.itemId || "",
    new Date(e.createdAt).toISOString(),
  ]);
  return tableLines(headers, rows);
}

export function formatHistory(revisions: { revision: number; draftId: string; publishedAt: number; reviewId: string }[]): string[] {
  if (revisions.length === 0) return ["No revisions."];
  const headers = ["REV", "DRAFT", "REVIEW", "PUBLISHED"];
  const rows = revisions.map((r) => [
    String(r.revision),
    r.draftId,
    r.reviewId,
    new Date(r.publishedAt).toISOString(),
  ]);
  return tableLines(headers, rows);
}
