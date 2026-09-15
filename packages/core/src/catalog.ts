/**
 * The trusted component catalogue (architecture §2).
 * The agent composes from these; it never ships arbitrary code.
 * Each component has a zod schema — validation is enforced server-side (§10).
 */
import { z } from "zod";
import { isSafeHttpUrl } from "./url.js";

const idRe = /^[a-zA-Z0-9_-]{1,64}$/;

/** http(s) only, no credentials, bounded length — see url.ts. */
export const zSafeUrl = z
  .string()
  .max(2000)
  .refine(isSafeHttpUrl, { message: "must be an http(s) URL without credentials" });

export const zActionSpec: z.ZodType<unknown> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("toggleItem"), dataset: z.string(), itemId: z.string() }),
  z.object({
    kind: z.literal("event"),
    type: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/),
    payload: z.record(z.unknown()).optional()
  }),
  z.object({ kind: z.literal("openDashboard") }),
  z.object({ kind: z.literal("openUrl"), href: zSafeUrl })
]);

const zOverflow = z.enum(["showMore", "scroll", "paginate", "clip", "expand"]).default("showMore");

/** Layout primitives */
export const LayoutComponents = {
  grid: z.object({
    columns: z.number().int().min(1).max(24).default(12),
    gap: z.number().min(0).max(64).default(12)
  }),
  stack: z.object({
    direction: z.enum(["vertical", "horizontal"]).default("vertical"),
    gap: z.number().min(0).max(64).default(8),
    align: z.enum(["start", "center", "end", "stretch"]).optional()
  }),
  section: z.object({
    title: z.string().max(200).optional(),
    emphasis: z.enum(["normal", "muted", "prominent"]).default("normal")
  }),
  card: z.object({
    title: z.string().max(200).optional(),
    emphasis: z.enum(["normal", "muted", "prominent"]).default("normal"),
    density: z.enum(["comfortable", "compact"]).default("comfortable")
  }),
  tabs: z.object({
    /** Tab label per child component id. Children without a label are grouped under "More". */
    labels: z.record(z.string().max(80)).default({})
  })
} as const;

/** Content components. Dataset references use `dataset: <datasetId>`. */
export const ContentComponents = {
  checklist: z.object({
    dataset: z.string(),
    maxVisible: z.number().int().min(1).max(200).default(6),
    overflow: zOverflow,
    showCompleted: z.boolean().default(true),
    completedCollapsed: z.boolean().default(true),
    emptyText: z.string().max(300).optional()
  }),
  metric: z.object({
    dataset: z.string(),
    field: z.string().max(100),
    label: z.string().max(200).optional(),
    unit: z.string().max(40).optional(),
    /** Optional target value renders a progress affordance. */
    target: z.number().optional()
  }),
  chart: z.object({
    dataset: z.string(),
    chartType: z.enum(["line", "bar"]),
    xField: z.string().max(100).default("t"),
    yFields: z.array(z.string().max(100)).min(1).max(8),
    title: z.string().max(200).optional(),
    maxPoints: z.number().int().min(2).max(2000).default(500)
  }),
  table: z.object({
    dataset: z.string(),
    columns: z.array(z.string().max(100)).min(1).max(30).optional(),
    maxRows: z.number().int().min(1).max(500).default(50),
    overflow: zOverflow
  }),
  text: z.object({
    /** Plain text only. Rich text/HTML is prohibited (untrusted-input policy §10). */
    content: z.string().max(10_000),
    style: z.enum(["body", "caption", "heading"]).default("body")
  }),
  image: z.object({
    /** Uploaded, access-controlled asset id. Arbitrary remote URLs are prohibited (§10). */
    assetId: z.string().regex(idRe),
    alt: z.string().max(300).optional(),
    fit: z.enum(["contain", "cover"]).default("contain"),
    /** Optional click behavior (e.g. openUrl to view the full page). */
    action: zActionSpec.optional()
  }),
  link: z.object({
    label: z.string().max(300),
    /** External page opened in the platform browser. http(s) only. */
    href: zSafeUrl,
    description: z.string().max(500).optional(),
    style: z.enum(["body", "caption", "heading"]).default("body")
  }),
  button: z.object({
    label: z.string().max(120),
    action: zActionSpec,
    variant: z.enum(["primary", "secondary", "danger"]).default("secondary")
  })
} as const;

export type LayoutComponentType = keyof typeof LayoutComponents;
export type ContentComponentType = keyof typeof ContentComponents;
export type ComponentType = LayoutComponentType | ContentComponentType;

export const LAYOUT_TYPES = Object.keys(LayoutComponents) as LayoutComponentType[];
export const CONTENT_TYPES = Object.keys(ContentComponents) as ContentComponentType[];
export const ALL_TYPES = [...LAYOUT_TYPES, ...CONTENT_TYPES] as ComponentType[];

export const COMPONENT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  ...LayoutComponents,
  ...ContentComponents
};

/** Components that bind to a dataset via a `dataset` prop. */
export const DATASET_BOUND = new Set<string>(["checklist", "metric", "chart", "table"]);

/** Components allowed to have children. */
export const CONTAINERS = new Set<string>(["grid", "stack", "section", "card", "tabs"]);

/** Human-readable catalogue description for `dashboard_context` guidance. */
export function catalogueDescription(): string {
  const lines: string[] = ["Component catalogue (type: props — notes):"];
  for (const t of LAYOUT_TYPES) {
    lines.push(`- ${t} (layout): ${shapeSummary(LayoutComponents[t as LayoutComponentType])}`);
  }
  for (const t of CONTENT_TYPES) {
    const bound = DATASET_BOUND.has(t) ? " [binds dataset via `dataset` prop]" : "";
    lines.push(`- ${t} (content)${bound}: ${shapeSummary(ContentComponents[t as ContentComponentType])}`);
  }
  lines.push(
    "Containers (grid, stack, section, card, tabs) accept children; content components do not.",
    "Responsive behavior: set per-target overrides (span/order/hidden/compact) instead of duplicating trees.",
    "Text is plain text only. Images are uploaded assets (dashboard_asset tool) referenced by assetId — remote URLs are not allowed.",
    "Links: the `link` component and the { kind: \"openUrl\", href } action open an external http(s) page in the platform browser; images accept an optional action to make them clickable.",
    "Other actions are restricted to toggleItem / event / openDashboard."
  );
  return lines.join("\n");
}

function shapeSummary(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    return Object.entries(shape)
      .map(([k, v]) => `${k}: ${describeType(v)}`)
      .join(", ");
  }
  return describeType(schema);
}

function describeType(v: z.ZodTypeAny): string {
  if (v instanceof z.ZodDefault) return `${describeType(v._def.innerType)} (optional)`;
  if (v instanceof z.ZodOptional) return `${describeType(v._def.innerType)} (optional)`;
  if (v instanceof z.ZodEnum) return v.options.join("|");
  if (v instanceof z.ZodString) return "string";
  if (v instanceof z.ZodNumber) return "number";
  if (v instanceof z.ZodBoolean) return "boolean";
  if (v instanceof z.ZodArray) return "array";
  if (v instanceof z.ZodRecord) return "record";
  if (v instanceof z.ZodDiscriminatedUnion) return "action";
  return "value";
}
