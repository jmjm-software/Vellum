import { validateDesign, fieldSet } from '@vellum/core/validate.js';
import type {
  DesignContent,
  Dataset,
  Diagnostic,
  ComponentNode,
  DatasetValue,
} from '@vellum/core/types.js';

export function collectDiagnostics(content: DesignContent, datasets: Dataset[]): Diagnostic[] {
  const knownDatasets = new Set(datasets.map((d) => d.id));
  const datasetSchemas = Object.fromEntries(datasets.map((d) => [d.id, d.schema]));
  const base = validateDesign(content, { knownDatasets, datasetSchemas });
  const diagnostics: Diagnostic[] = [...base.diagnostics];
  const dsMap = new Map<string, Dataset>(datasets.map((d) => [d.id, d]));

  function walk(node: ComponentNode) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    switch (node.type) {
      case 'checklist': {
        const dsId = props.dataset as string;
        const ds = dsMap.get(dsId);
        if (!ds) {
          diagnostics.push({
            severity: 'warning',
            code: 'missing_dataset',
            message: `Checklist "${node.id}" missing dataset "${dsId}"`,
            componentId: node.id,
          });
        } else if (ds.schema.kind !== 'list') {
          diagnostics.push({
            severity: 'warning',
            code: 'dataset_kind_mismatch',
            message: `Checklist "${node.id}" expects list dataset`,
            componentId: node.id,
          });
        } else {
          const items = (ds.value as Extract<DatasetValue, { kind: 'list' }>).items;
          for (const it of items) {
            if (it.label.length > 500) {
              diagnostics.push({
                severity: 'warning',
                code: 'long_label',
                message: `Checklist "${node.id}" has label >500 chars`,
                componentId: node.id,
              });
              break;
            }
          }
        }
        break;
      }
      case 'metric': {
        const dsId = props.dataset as string;
        const ds = dsMap.get(dsId);
        if (!ds) {
          diagnostics.push({
            severity: 'warning',
            code: 'missing_dataset',
            message: `Metric "${node.id}" missing dataset "${dsId}"`,
            componentId: node.id,
          });
        } else if (ds.schema.kind !== 'metric') {
          diagnostics.push({
            severity: 'warning',
            code: 'dataset_kind_mismatch',
            message: `Metric "${node.id}" expects metric dataset`,
            componentId: node.id,
          });
        } else {
          const field = props.field as string;
          const values = (ds.value as Extract<DatasetValue, { kind: 'metric' }>).values;
          if (!(field in values)) {
            diagnostics.push({
              severity: 'warning',
              code: 'missing_value',
              message: `Metric "${node.id}" missing field value`,
              componentId: node.id,
            });
          }
        }
        break;
      }
      case 'chart': {
        const dsId = props.dataset as string;
        const ds = dsMap.get(dsId);
        if (!ds) {
          diagnostics.push({
            severity: 'warning',
            code: 'missing_dataset',
            message: `Chart "${node.id}" missing dataset "${dsId}"`,
            componentId: node.id,
          });
        } else if (ds.schema.kind !== 'timeseries') {
          diagnostics.push({
            severity: 'warning',
            code: 'dataset_kind_mismatch',
            message: `Chart "${node.id}" expects timeseries dataset`,
            componentId: node.id,
          });
        } else {
          const yFields = (props.yFields as string[]) ?? [];
          const allowed = fieldSet(ds.schema);
          if (allowed) {
            for (const f of yFields) {
              if (!allowed.has(f)) {
                diagnostics.push({
                  severity: 'warning',
                  code: 'unknown_field',
                  message: `Chart "${node.id}" unknown yField "${f}"`,
                  componentId: node.id,
                });
              }
            }
          }
        }
        break;
      }
      case 'table': {
        const dsId = props.dataset as string;
        const ds = dsMap.get(dsId);
        if (!ds) {
          diagnostics.push({
            severity: 'warning',
            code: 'missing_dataset',
            message: `Table "${node.id}" missing dataset "${dsId}"`,
            componentId: node.id,
          });
        } else if (ds.schema.kind !== 'records') {
          diagnostics.push({
            severity: 'warning',
            code: 'dataset_kind_mismatch',
            message: `Table "${node.id}" expects records dataset`,
            componentId: node.id,
          });
        } else {
          const columns = props.columns as string[] | undefined;
          const allowed = fieldSet(ds.schema);
          if (allowed && columns) {
            for (const c of columns) {
              if (!allowed.has(c)) {
                diagnostics.push({
                  severity: 'warning',
                  code: 'unknown_column',
                  message: `Table "${node.id}" unknown column "${c}"`,
                  componentId: node.id,
                });
              }
            }
          }
        }
        break;
      }
      case 'text': {
        const text = props.content as string;
        if (text && text.length > 500) {
          diagnostics.push({
            severity: 'warning',
            code: 'long_text',
            message: `Text "${node.id}" is ${text.length} chars`,
            componentId: node.id,
          });
        }
        break;
      }
      case 'button': {
        const action = props.action as { kind: string; dataset?: string } | undefined;
        if (action?.kind === 'toggleItem' && action.dataset) {
          if (!dsMap.has(action.dataset)) {
            diagnostics.push({
              severity: 'warning',
              code: 'missing_dataset',
              message: `Button "${node.id}" references unknown dataset`,
              componentId: node.id,
            });
          }
        }
        break;
      }
    }
    for (const child of node.children ?? []) walk(child);
  }

  walk(content.root);
  return diagnostics;
}
