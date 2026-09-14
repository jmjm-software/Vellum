# @vellum/renderer

React 18 renderer for Vellum dashboard designs.

## API

- `DashboardRenderer({ content, datasets, target, onAction, width?, preview? })` — renders a `DesignContent` tree bound to datasets for a given target.
- `collectDiagnostics(content, datasets)` — structural and data-fit diagnostics (builds on core `validateDesign`).

## Files

- `src/index.ts` — public exports
- `src/components.tsx` — all catalogue components (grid, stack, section, card, tabs, checklist, metric, chart, table, text, image, button) and `DashboardRenderer`
- `src/diagnostics.ts` — `collectDiagnostics`
- `src/styles.css` — plain CSS dark-neutral responsive theme (360px–1280px+)

Deterministic rendering: no animations or randomness. Every component root carries `data-component-id`.
