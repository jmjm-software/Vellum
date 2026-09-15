/**
 * Validation for agent-authored design documents and dataset values.
 * Agent-authored documents and imported data are untrusted input (§10):
 * every property is schema-checked, ids are constrained, sizes are bounded.
 */
import { z } from "zod";
import {
  COMPONENT_SCHEMAS,
  CONTAINERS,
  DATASET_BOUND,
  zSafeUrl,
  type ComponentType
} from "./catalog.js";
import {
  DATA_LIMITS,
  FORMAT_VERSION,
  type DatasetSchema,
  type DatasetValue,
  type DesignContent,
  type Diagnostic,
  type ListItem
} from "./types.js";

const idRe = /^[a-zA-Z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Design document
// ---------------------------------------------------------------------------

const zComponentNode: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    id: z.string().regex(idRe),
    type: z.string(),
    props: z.record(z.unknown()).optional(),
    children: z.array(zComponentNode).max(200).optional()
  })
);

const zTargetOverride = z.object({
  span: z.number().int().min(1).max(24).optional(),
  order: z.number().int().min(-1000).max(1000).optional(),
  hidden: z.boolean().optional(),
  compact: z.boolean().optional()
});

const zWidgetComponent: z.ZodType<unknown> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().max(200), emphasis: z.enum(["title", "normal", "caption"]).optional() }),
  z.object({ kind: z.literal("metric"), dataset: z.string(), field: z.string(), label: z.string().max(80).optional(), unit: z.string().max(20).optional() }),
  z.object({ kind: z.literal("list"), dataset: z.string(), maxItems: z.number().int().min(1).max(10), filter: z.enum(["unchecked", "all"]).optional(), showRemainingCount: z.boolean().optional() }),
  z.object({ kind: z.literal("progress"), dataset: z.string(), label: z.string().max(80).optional() }),
  z.object({ kind: z.literal("image"), assetId: z.string().regex(idRe), alt: z.string().max(200).optional() }),
  z.object({ kind: z.literal("link"), label: z.string().max(80), href: zSafeUrl }),
  z.object({
    kind: z.literal("action"),
    label: z.string().max(80),
    action: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("toggleItem"), dataset: z.string(), itemId: z.string() }),
      z.object({ kind: z.literal("event"), type: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/), payload: z.record(z.unknown()).optional() }),
      z.object({ kind: z.literal("openDashboard") }),
      z.object({ kind: z.literal("openUrl"), href: zSafeUrl })
    ])
  })
]);

export const zDesignContent = z.object({
  formatVersion: z.literal(FORMAT_VERSION),
  catalogueVersion: z.string().max(20),
  root: zComponentNode,
  overrides: z
    .object({
      phone: z.record(zTargetOverride).optional(),
      desktop: z.record(zTargetOverride).optional(),
      widget: z.record(zTargetOverride).optional()
    })
    .optional(),
  datasets: z.array(z.string().regex(idRe)).max(50),
  intent: z
    .object({
      purpose: z.string().max(2000).optional(),
      priorities: z.array(z.string().max(500)).max(50).optional(),
      notes: z.string().max(4000).optional()
    })
    .optional(),
  widget: z
    .object({
      components: z.array(zWidgetComponent).max(10),
      datasets: z.array(z.string().regex(idRe)).max(10)
    })
    .nullable()
    .optional()
});

export interface ValidateDesignOptions {
  /** Dataset ids known to exist (for binding checks). If omitted, binding checks are skipped. */
  knownDatasets?: Set<string>;
  /** Dataset schemas keyed by id, for field-level binding validation. */
  datasetSchemas?: Record<string, DatasetSchema>;
  /** Uploaded asset ids known to exist (for image binding checks). */
  knownAssets?: Set<string>;
}

/** Full structural + semantic validation of a design document. */
export function validateDesign(input: unknown, opts: ValidateDesignOptions = {}): {
  content: DesignContent | null;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const parsed = zDesignContent.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) {
      diagnostics.push({
        severity: "error",
        code: "schema",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`
      });
    }
    return { content: null, diagnostics };
  }
  const content = parsed.data as unknown as DesignContent;

  const seenIds = new Set<string>();
  const declared = new Set<string>();

  const walk = (node: DesignContent["root"], depth: number, parentAllowsChildren: boolean) => {
    if (depth > 20) {
      diagnostics.push({ severity: "error", code: "depth", message: `Component tree exceeds depth 20 at ${node.id}`, componentId: node.id });
      return;
    }
    if (seenIds.has(node.id)) {
      diagnostics.push({ severity: "error", code: "duplicate_id", message: `Duplicate component id "${node.id}"`, componentId: node.id });
    }
    seenIds.add(node.id);

    const schema = COMPONENT_SCHEMAS[node.type];
    if (!schema) {
      diagnostics.push({ severity: "error", code: "unknown_component", message: `Unknown component type "${node.type}"`, componentId: node.id });
    } else {
      const propCheck = schema.safeParse(node.props ?? {});
      if (!propCheck.success) {
        for (const issue of propCheck.error.issues.slice(0, 5)) {
          diagnostics.push({
            severity: "error",
            code: "props",
            message: `${node.type}.${issue.path.join(".") || "(props)"}: ${issue.message}`,
            componentId: node.id
          });
        }
      } else {
        // Normalize props with defaults applied.
        node.props = propCheck.data as Record<string, unknown>;
        const props = node.props;
        if (DATASET_BOUND.has(node.type)) {
          const dsId = String(props["dataset"] ?? "");
          declared.add(dsId);
          if (opts.knownDatasets && !opts.knownDatasets.has(dsId)) {
            diagnostics.push({ severity: "error", code: "unknown_dataset", message: `${node.type} "${node.id}" binds unknown dataset "${dsId}"`, componentId: node.id });
          }
          const dsSchema = opts.datasetSchemas?.[dsId];
          if (dsSchema && propCheck.success) {
            checkFieldBinding(node, props, dsSchema, diagnostics);
          }
        }
        if (node.type === "button") {
          const action = props["action"] as { kind: string; dataset?: string } | undefined;
          if (action?.kind === "toggleItem" && action.dataset) {
            declared.add(action.dataset);
          }
        }
        if (node.type === "image" && opts.knownAssets) {
          const assetId = String(props["assetId"] ?? "");
          if (!opts.knownAssets.has(assetId)) {
            diagnostics.push({
              severity: "error",
              code: "unknown_asset",
              message: `image "${node.id}" references unknown asset "${assetId}" — upload it with dashboard_asset first`,
              componentId: node.id
            });
          }
        }
      }
    }

    const children = node.children ?? [];
    if (children.length > 0 && !CONTAINERS.has(node.type)) {
      diagnostics.push({ severity: "error", code: "children_not_allowed", message: `Component "${node.type}" cannot have children`, componentId: node.id });
    }
    if (CONTAINERS.has(node.type) && children.length === 0) {
      diagnostics.push({ severity: "warning", code: "empty_container", message: `Container "${node.type}" (${node.id}) has no children`, componentId: node.id });
    }
    for (const child of children) walk(child as DesignContent["root"], depth + 1, CONTAINERS.has(node.type));
  };

  walk(content.root, 0, true);

  // Widget bindings count as declared too.
  if (content.widget) {
    for (const ds of content.widget.datasets) declared.add(ds);

    // Launcher-surface sanity: the widget is a tiny, single-line, no-scroll
    // surface. These are warnings (the agent decides), but they are exactly the
    // things that make a widget look wrong — and the widget is not covered by
    // the screenshot review, so feedback has to come from here.
    const widget = content.widget;
    if (widget.components.length > 6) {
      diagnostics.push({
        severity: "warning",
        code: "widget_too_many_components",
        message: `widget has ${widget.components.length} components; launcher widgets read best with ≤6 (title, one list, maybe a metric/image, one action)`
      });
    }
    for (const component of widget.components) {
      if (component.kind === "text" && component.emphasis !== "caption" && component.text.length > 40) {
        diagnostics.push({
          severity: "warning",
          code: "widget_text_too_long",
          message: `widget text "${component.text.slice(0, 24)}…" is ${component.text.length} chars; widget text is single-line — keep it short or move detail to the dashboard`
        });
      }
      if (component.kind === "link" && component.label.length > 40) {
        diagnostics.push({
          severity: "warning",
          code: "widget_text_too_long",
          message: "widget link label is long; widget rows are single-line"
        });
      }
      if (component.kind === "action" && component.label.length > 40) {
        diagnostics.push({
          severity: "warning",
          code: "widget_text_too_long",
          message: "widget action label is long; widget rows are single-line"
        });
      }
      if (component.kind === "list" && component.maxItems > 6) {
        diagnostics.push({
          severity: "warning",
          code: "widget_list_long",
          message: `widget list maxItems=${component.maxItems}; more than ~6 items will not fit on a launcher widget (use showRemainingCount and let the dashboard show the rest)`
        });
      }
    }
    if (opts.knownAssets) {
      for (const component of content.widget.components) {
        if (component.kind === "image" && !opts.knownAssets.has(component.assetId)) {
          diagnostics.push({
            severity: "error",
            code: "unknown_asset",
            message: `widget image references unknown asset "${component.assetId}" — upload it with dashboard_asset first`
          });
        }
      }
    }
  }

  // Declared datasets list vs actual bindings.
  const declaredList = new Set(content.datasets);
  for (const ds of declared) {
    if (!declaredList.has(ds)) {
      diagnostics.push({ severity: "error", code: "undeclared_dataset", message: `Dataset "${ds}" is bound by a component but missing from content.datasets` });
    }
  }
  for (const ds of declaredList) {
    if (!declared.has(ds)) {
      diagnostics.push({ severity: "warning", code: "unused_dataset", message: `Dataset "${ds}" is declared but not bound by any component or widget` });
    }
  }

  // Overrides must reference known component ids.
  for (const [target, map] of Object.entries(content.overrides ?? {})) {
    for (const cid of Object.keys(map ?? {})) {
      if (!seenIds.has(cid)) {
        diagnostics.push({ severity: "error", code: "unknown_override_target", message: `Override for unknown component "${cid}" on ${target}`, componentId: cid });
      }
    }
  }

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  return { content: hasErrors ? null : content, diagnostics };
}

function checkFieldBinding(
  node: { id: string; type: string },
  props: Record<string, unknown>,
  schema: DatasetSchema,
  diagnostics: Diagnostic[]
) {
  const fieldNames = fieldSet(schema);
  if (!fieldNames) return;
  const fields: string[] = [];
  if (node.type === "metric" && typeof props["field"] === "string") fields.push(props["field"]);
  if (node.type === "chart" && Array.isArray(props["yFields"])) fields.push(...(props["yFields"] as string[]));
  for (const f of fields) {
    if (!fieldNames.has(f)) {
      diagnostics.push({
        severity: "warning",
        code: "unknown_field",
        message: `${node.type} "${node.id}" references field "${f}" not present in dataset schema (${[...fieldNames].join(", ")})`,
        componentId: node.id
      });
    }
  }
}

export function fieldSet(schema: DatasetSchema): Set<string> | null {
  if (schema.kind === "metric") return new Set(schema.fields.map((f) => f.name));
  if (schema.kind === "timeseries") return new Set(schema.series.map((f) => f.name));
  if (schema.kind === "records") return new Set(schema.columns.map((c) => c.name));
  return null;
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export const zDatasetSchema: z.ZodType<DatasetSchema> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), maxItems: z.number().int().min(1).max(DATA_LIMITS.maxListItems).optional() }),
  z.object({
    kind: z.literal("metric"),
    fields: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/), unit: z.string().max(40).optional() })).min(1).max(50)
  }),
  z.object({
    kind: z.literal("timeseries"),
    series: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/), unit: z.string().max(40).optional() })).min(1).max(20),
    maxSamples: z.number().int().min(2).max(DATA_LIMITS.maxTimeseriesSamples).optional()
  }),
  z.object({
    kind: z.literal("records"),
    columns: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/), type: z.enum(["string", "number", "boolean"]) })).min(1).max(50),
    maxRows: z.number().int().min(1).max(DATA_LIMITS.maxRecordRows).optional()
  })
]);

/** Validate a dataset value against its schema and size limits. */
export function validateDatasetValue(schema: DatasetSchema, value: unknown): { value: DatasetValue | null; errors: string[] } {
  const errors: string[] = [];
  const raw = JSON.stringify(value ?? null);
  if (raw.length > DATA_LIMITS.maxPayloadBytes) {
    return { value: null, errors: [`payload exceeds ${DATA_LIMITS.maxPayloadBytes} bytes`] };
  }

  switch (schema.kind) {
    case "list": {
      const p = z
        .object({
          kind: z.literal("list"),
          items: z
            .array(
              z.object({
                id: z.string().regex(idRe),
                label: z.string().max(DATA_LIMITS.maxLabelLength),
                done: z.boolean().optional(),
                meta: z.record(z.string().max(DATA_LIMITS.maxLabelLength)).optional()
              })
            )
            .max(schema.maxItems ?? DATA_LIMITS.maxListItems)
        })
        .safeParse(value);
      if (!p.success) return { value: null, errors: issues(p.error) };
      const items = (p.data.items as ListItem[]);
      const ids = new Set<string>();
      for (const it of items) {
        if (ids.has(it.id)) errors.push(`duplicate list item id "${it.id}"`);
        ids.add(it.id);
      }
      return errors.length ? { value: null, errors } : { value: { kind: "list", items }, errors: [] };
    }
    case "metric": {
      const allowed = new Set(schema.fields.map((f) => f.name));
      const p = z.object({ kind: z.literal("metric"), values: z.record(z.number()) }).safeParse(value);
      if (!p.success) return { value: null, errors: issues(p.error) };
      for (const k of Object.keys(p.data.values)) {
        if (!allowed.has(k)) errors.push(`unknown metric field "${k}"`);
        if (!Number.isFinite(p.data.values[k]!)) errors.push(`metric field "${k}" is not finite`);
      }
      return errors.length ? { value: null, errors } : { value: { kind: "metric", values: p.data.values }, errors: [] };
    }
    case "timeseries": {
      const allowed = new Set(schema.series.map((f) => f.name));
      const p = z
        .object({
          kind: z.literal("timeseries"),
          samples: z
            .array(z.object({ t: z.number().int(), values: z.record(z.number()) }))
            .max(schema.maxSamples ?? DATA_LIMITS.maxTimeseriesSamples)
        })
        .safeParse(value);
      if (!p.success) return { value: null, errors: issues(p.error) };
      for (const s of p.data.samples) {
        for (const k of Object.keys(s.values)) {
          if (!allowed.has(k)) errors.push(`unknown series "${k}" at t=${s.t}`);
        }
      }
      return errors.length ? { value: null, errors } : { value: { kind: "timeseries", samples: p.data.samples }, errors: [] };
    }
    case "records": {
      const cols = new Map(schema.columns.map((c) => [c.name, c.type]));
      const p = z
        .object({
          kind: z.literal("records"),
          rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(schema.maxRows ?? DATA_LIMITS.maxRecordRows)
        })
        .safeParse(value);
      if (!p.success) return { value: null, errors: issues(p.error) };
      for (const row of p.data.rows) {
        for (const [k, v] of Object.entries(row)) {
          const t = cols.get(k);
          if (!t) {
            errors.push(`unknown column "${k}"`);
          } else if (v !== null && typeof v !== t) {
            errors.push(`column "${k}" expects ${t}, got ${typeof v}`);
          }
        }
      }
      return errors.length ? { value: null, errors } : { value: { kind: "records", rows: p.data.rows }, errors: [] };
    }
  }
}

export function emptyValue(schema: DatasetSchema): DatasetValue {
  switch (schema.kind) {
    case "list":
      return { kind: "list", items: [] };
    case "metric":
      return { kind: "metric", values: {} };
    case "timeseries":
      return { kind: "timeseries", samples: [] };
    case "records":
      return { kind: "records", rows: [] };
  }
}

function issues(e: z.ZodError): string[] {
  return e.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

// ---------------------------------------------------------------------------
// Patch operations for dashboard_edit
// ---------------------------------------------------------------------------

export type DesignPatch =
  | { op: "replaceRoot"; root: DesignContent["root"] }
  | { op: "insert"; parentId: string; index?: number; node: DesignContent["root"] }
  | { op: "remove"; id: string }
  | { op: "updateProps"; id: string; props: Record<string, unknown> }
  | { op: "move"; id: string; parentId: string; index?: number }
  | { op: "setOverride"; target: "phone" | "desktop" | "widget"; id: string; override: Record<string, unknown> | null }
  | { op: "setDatasets"; datasets: string[] }
  | { op: "setIntent"; intent: DesignContent["intent"] }
  | { op: "setWidget"; widget: DesignContent["widget"] };

export const zDesignPatch = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replaceRoot"), root: zComponentNode }),
  z.object({ op: z.literal("insert"), parentId: z.string(), index: z.number().int().min(0).optional(), node: zComponentNode }),
  z.object({ op: z.literal("remove"), id: z.string() }),
  z.object({ op: z.literal("updateProps"), id: z.string(), props: z.record(z.unknown()) }),
  z.object({ op: z.literal("move"), id: z.string(), parentId: z.string(), index: z.number().int().min(0).optional() }),
  z.object({ op: z.literal("setOverride"), target: z.enum(["phone", "desktop", "widget"]), id: z.string(), override: z.record(z.unknown()).nullable() }),
  z.object({ op: z.literal("setDatasets"), datasets: z.array(z.string()) }),
  z.object({ op: z.literal("setIntent"), intent: z.object({ purpose: z.string().optional(), priorities: z.array(z.string()).optional(), notes: z.string().optional() }).optional().nullable().transform((v) => v ?? undefined) as z.ZodType<DesignContent["intent"]> }),
  z.object({ op: z.literal("setWidget"), widget: z.object({ components: z.array(z.unknown()), datasets: z.array(z.string()) }).nullable().optional() as z.ZodType<DesignContent["widget"]> })
]) as unknown as z.ZodType<DesignPatch>;

/** Apply patches to a deep copy of the design. Throws on structural errors. */
export function applyPatches(content: DesignContent, patches: DesignPatch[]): DesignContent {
  const next: DesignContent = JSON.parse(JSON.stringify(content));
  for (const patch of patches) {
    switch (patch.op) {
      case "replaceRoot":
        next.root = patch.root as DesignContent["root"];
        break;
      case "insert": {
        const parent = findNode(next.root, patch.parentId);
        if (!parent) throw new PatchError(`parent "${patch.parentId}" not found`);
        if (!CONTAINERS.has(parent.type)) throw new PatchError(`"${parent.type}" cannot contain children`);
        parent.children ??= [];
        const idx = Math.min(patch.index ?? parent.children.length, parent.children.length);
        parent.children.splice(idx, 0, patch.node as DesignContent["root"]);
        break;
      }
      case "remove": {
        if (!removeNode(next.root, patch.id)) throw new PatchError(`component "${patch.id}" not found`);
        break;
      }
      case "updateProps": {
        const node = findNode(next.root, patch.id);
        if (!node) throw new PatchError(`component "${patch.id}" not found`);
        node.props = { ...(node.props ?? {}), ...patch.props };
        break;
      }
      case "move": {
        const detached = detachNode(next.root, patch.id);
        if (!detached) throw new PatchError(`component "${patch.id}" not found`);
        const parent = findNode(next.root, patch.parentId);
        if (!parent) throw new PatchError(`parent "${patch.parentId}" not found`);
        if (!CONTAINERS.has(parent.type)) throw new PatchError(`"${parent.type}" cannot contain children`);
        parent.children ??= [];
        const idx = Math.min(patch.index ?? parent.children.length, parent.children.length);
        parent.children.splice(idx, 0, detached);
        break;
      }
      case "setOverride": {
        next.overrides ??= {};
        const map = (next.overrides[patch.target] ??= {});
        if (patch.override === null) delete map[patch.id];
        else map[patch.id] = patch.override as Record<string, never>;
        break;
      }
      case "setDatasets":
        next.datasets = patch.datasets;
        break;
      case "setIntent":
        next.intent = patch.intent;
        break;
      case "setWidget":
        next.widget = patch.widget ?? null;
        break;
    }
  }
  return next;
}

export class PatchError extends Error {}

type Node = DesignContent["root"];

export function findNode(root: Node, id: string): Node | null {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const hit = findNode(c as Node, id);
    if (hit) return hit;
  }
  return null;
}

function removeNode(root: Node, id: string): boolean {
  const children = root.children ?? [];
  for (let i = 0; i < children.length; i++) {
    if ((children[i] as Node).id === id) {
      children.splice(i, 1);
      return true;
    }
    if (removeNode(children[i] as Node, id)) return true;
  }
  return false;
}

function detachNode(root: Node, id: string): Node | null {
  const children = root.children ?? [];
  for (let i = 0; i < children.length; i++) {
    if ((children[i] as Node).id === id) return children.splice(i, 1)[0] as Node;
    const hit = detachNode(children[i] as Node, id);
    if (hit) return hit;
  }
  return null;
}

/** Collect all component ids in a tree. */
export function collectIds(root: Node): string[] {
  const out: string[] = [root.id];
  for (const c of root.children ?? []) out.push(...collectIds(c as Node));
  return out;
}

export type { ComponentType };
