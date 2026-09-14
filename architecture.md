
The architecture I would choose is:

> **One persistent dashboard service, controlled through one MCP connection, with an agent-authored component layout, a shared web/Android renderer, separate data updates, and a guarded preview-to-publish workflow.**

No required skill. No second AI agent hidden inside the dashboard. No attempt to build a universal replacement for HTML, Android UI, and terminal graphics simultaneously. The shopping list does not need its own civilization.

Here is the design I would hand to an implementer.

# 1. Define the product correctly

This is an **agent-designed dashboard**, not a dashboard that merely displays agent-generated content.

The agent owns composition: component selection, arrangement, grouping, prominence, responsive behavior, and decisions about what belongs on the main screen versus a secondary view.

The dashboard owns execution: storing data, rendering components, enforcing constraints, handling interactions, producing previews, and publishing revisions safely.

That distinction allows both statements to be true:

**The agent decides the design.**

**The application does not blindly execute every design mistake the agent makes.**

For example, the agent decides that shopping should occupy the upper-right third of the desktop dashboard and appear first on mobile. The renderer calculates the actual grid dimensions, wraps text, and implements the agent’s chosen overflow behavior.

The renderer must not independently decide that power consumption is more important than shopping. That is the agent’s job.

## The system boundary

```text
External services and devices
              ▲
              │ Existing tools and integrations
              ▼
       User's AI harness
              │
              │ One MCP connection
              ▼
┌─────────────────────────────────────────────────┐
│               Dashboard service                 │
│                                                 │
│  MCP tools and instructions                     │
│  Dashboard layouts and datasets                 │
│  Drafts, previews, validation, publication       │
│  User actions and pending harness events        │
│  Authentication and authorization               │
│                                                 │
│  Preview worker using the production renderer    │
└───────────────────────┬─────────────────────────┘
                        │
                   Client API
                        │
          ┌─────────────┼────────────────┐
          ▼             ▼                ▼
         Web       Android app          CLI
                        │
                        ▼
                 Launcher widgets
```

The dashboard service has no shopping-service credentials, smart-home integration, or health-service connector. Those remain with the harness.

The dashboard must remain usable when the agent is disconnected. It displays its stored state, with freshness information where appropriate.

# 2. Use an agent-authored component document, not generated application code

There are three plausible approaches.

**Semantic content with automatic layout** is too restrictive for your stated goal. It makes the application the designer.

**Arbitrary generated HTML, CSS, and JavaScript** gives the agent maximum freedom, but also makes every dashboard revision a small software deployment. That introduces code isolation, dependency management, unpredictable behavior, and a much larger testing problem.

**Agent-authored composition from trusted components** is the best fit here.

The implementer builds the components once. The agent designs the actual dashboards.

The component catalogue should include layout primitives such as grids, stacks, sections, and tabs, alongside content components such as checklists, metrics, tables, charts, images, and actions.

The agent should control meaningful properties: spans, ordering, grouping, density, emphasis, chart configuration, responsive overrides, and overflow policy. It should not be confined to choosing among three hard-coded dashboard templates.

For example, its design might express:

```text
Desktop:
  Main grid: 12 columns
  Power chart: 8 columns
  Shopping panel: 4 columns
  Health summary: next row, 12 columns

Phone:
  Shopping panel first
  Health summary second
  Power chart third, compact presentation

Shopping panel:
  Show up to 6 items before "Show all"
  Keep completed items collapsed
  Show an explicit empty state
```

That is the agent designing the interface. There is no need for it to invent the checkbox implementation.

## Reuse rendering infrastructure

For a React implementation, my starting choice would be **json-render with a project-owned component catalogue**, rather than writing a generic JSON-to-UI engine from scratch. Its documented model already covers component catalogues, agent-generated structure, data bindings, and actions. ([json-render][1])

Use it as an internal library, not as the definition of your entire product.

Your own versioned dashboard envelope should contain the layout specification, dataset references, target-specific presentations, and compatibility metadata. Revision management and publishing belong to your service.

The library does not replace the need to build good components or validate your catalogue. I have checked the architectural fit in its documentation, not benchmarked a prototype.

**Do not support several competing UI formats in version one.** That creates conversion work without improving the user experience you described.

# 3. Separate design from data

This is the most important change from the earlier proposal.

**A temperature update is not a dashboard redesign.**

Use separate concepts for:

| Concept             | Responsibility                                                      |
| ------------------- | ------------------------------------------------------------------- |
| **Dataset**         | Values, records, list items, and time-series samples                |
| **Design revision** | Components, data bindings, layout, styling, and responsive behavior |
| **Publication**     | The approved design revision clients should display                 |
| **Action/event**    | A user interaction and its processing state                         |

A shopping component references a dataset. It does not contain the only copy of the shopping list inside its layout document.

For example:

```text
Dataset: shopping
  items, completion states, timestamps

Design revision: 17
  shopping panel placement
  checklist presentation
  responsive ordering
  overflow behavior

Publication: 12
  points to design revision 17
```

This gives you two workflows.

**Design change:** adding shopping, moving panels, changing chart types, or reorganizing the dashboard requires draft, preview, review, and publication.

**Data change:** checking an item or updating a temperature changes the dataset without redesigning the page.

Data updates must still pass their schema and size constraints. Changes outside the existing presentation contract should trigger a design-review request or a safe overflow state.

Otherwise you end up asking an expensive model to reconsider visual hierarchy every time someone buys milk.

## Define data ownership

Each dataset must declare whether it is:

**Dashboard-owned:** the dashboard is the authoritative store. A simple shopping list can work entirely this way.

**Externally mirrored:** another service is authoritative, and the harness supplies snapshots or updates.

Store timestamps and optional opaque source references for mirrored data, but not external credentials.

This distinction becomes essential when users interact with the dashboard.

# 4. Share one renderer between web and the Android app

I would start with a **web renderer reused inside an Android WebView**.

Android explicitly supports embedding web content through WebView. This makes a shared rendering implementation possible; it does not guarantee identical behavior on every browser and Android device. ([Android Entwickler][2])

My implementation choice would be:

```text
Shared React renderer
        ├── Browser application
        ├── Android WebView application
        └── Browser-based preview worker
```

The Android application supplies the native shell: account setup, local caching, deep links, widget integration, and lifecycle handling.

The dashboard itself uses the same component implementation and styling as the web application.

This is a deliberate tradeoff. You give up a fully native implementation of every in-app component in exchange for much less rendering divergence and a more meaningful preview loop.

I would not introduce a second full native renderer until there is a demonstrated requirement for it.

## Launcher widgets are a different surface

An Android launcher widget is not simply a tiny browser window. Widget layouts use a restricted platform model; Android’s documentation explicitly notes limitations in supported views and layouts. Jetpack Glance provides widget-specific APIs and is not directly interchangeable with ordinary Compose UI. ([Android Entwickler][3])

Therefore, model widgets as **agent-designed compact presentations of the same datasets**, not scaled-down copies of the full dashboard.

For example:

```text
Main dashboard:
  Shopping checklist
  Weekly energy chart
  Health summary

Launcher widget:
  Shopping title
  Four unchecked items
  Remaining-item count
  Open-dashboard action
```

The agent chooses the widget’s content, ordering, emphasis, and supported presentation options. A small trusted native widget renderer implements them.

Build that renderer with Kotlin and Glance. Initially support a deliberately small catalogue: text, metrics, lists, progress, images, and approved actions.

Use actual size ranges rather than assuming every launcher’s “4 × 2” means the same dimensions. Android’s guidance specifically warns that launcher cell sizes vary and recommends flexible sizing strategies. ([Android Entwickler][4])

**Do not claim that a browser screenshot validates a native widget.** When widget editing is enabled, its preview path must exercise the native implementation.

## Keep the CLI honest

Your original requirement was a CLI, not a complete graphical dashboard recreated in an 80-column terminal.

Initially, the CLI should provide dashboard status, data inspection, lists and tables, event inspection, history, and rollback.

It can render a compact terminal presentation of the same information. A full TUI can come later without forcing every graphical component into a lowest-common-denominator format.

# 5. Expose the complete workflow through one MCP server

**One MCP connection is enough for the agent-facing integration.**

MCP supports tool results containing images as well as structured content, so previews and machine-readable diagnostics can travel through the same tool interface. ([Model Context Protocol][5])

I would start with these tools:

| Tool                | Purpose                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `dashboard_context` | Read the current design, dataset summaries, target capabilities, and relevant authoring guidance |
| `dashboard_edit`    | Create or patch a draft using stable component IDs                                               |
| `dashboard_preview` | Render an exact draft version and return screenshots, diagnostics, and a review ID               |
| `dashboard_publish` | Publish the reviewed draft after checking server-side preconditions                              |
| `dashboard_data`    | Read or apply validated, versioned dataset changes                                               |
| `dashboard_events`  | Read, claim, and acknowledge pending harness-directed actions                                    |

History and restoration can be added as focused tools when needed.

Do not obsess over having exactly four tools. A small, coherent interface is useful. Hiding unrelated operations inside one enormous argument schema is not simplicity.

## Bundle the guidance

Include concise server instructions, precise tool descriptions, and relevant examples in `dashboard_context`.

Current MCP discovery includes an instructions field, but how a host incorporates server guidance remains an implementation concern. Do not make correct behavior depend entirely on the host injecting one particular paragraph into its prompt. ([Model Context Protocol][6])

The essential guidance should say:

> Inspect the existing dashboard. Preserve user intent and useful content. Reorganize when necessary rather than merely appending. Preview the affected targets. Inspect the returned images. Repair problems. Publish only the reviewed draft.

Tool responses should reinforce the next required step. The backend must enforce publication requirements.

**No separately installed skill is necessary.**

## Define supported harness capabilities

The full experience requires a harness that can deliver tool-result images to a vision-capable model and execute a multi-step tool loop.

“Supports MCP” alone is not sufficient evidence that this works correctly. Test the complete workflow in the harnesses you intend to support.

A host that cannot pass screenshots to the model can still support data operations, but it cannot deliver your promised agent visual-review workflow.

MCP Apps are optional. They provide interactive interfaces inside supported MCP hosts, whereas your primary product lives independently on phones, browsers, and launchers. Do not make them a dependency of the core dashboard. ([Model Context Protocol][7])

# 6. Make publication a transaction over a reviewed revision

The workflow should be:

```text
Read published dashboard
          ↓
Create or patch draft
          ↓
Preview exact draft version
          ↓
Agent inspects screenshots and diagnostics
          ↓
Patch and preview again as needed
          ↓
Publish reviewed version
```

The essential detail is **exact draft version**.

A draft being rendered once does not make every later edit to that draft publishable.

Each edit increments the draft version. Each preview produces a review record bound to:

```text
Draft ID and version
Design content hash
Renderer/catalogue version
Target profiles tested
Dataset snapshots used
Validation results
Screenshot artifacts
```

Changing the design invalidates its previous review.

A publication request should identify the review and the published revision it expects to replace:

```json
{
  "draftId": "draft_43",
  "reviewId": "review_81",
  "expectedPublishedRevision": 42,
  "idempotencyKey": "publish-shopping-001"
}
```

The backend verifies that the review matches the current draft, all required target checks completed, blocking errors are absent, and another writer has not replaced the expected published revision.

Then it updates the publication pointer in a database transaction.

New datasets introduced by the draft should become available consistently with the design that references them. Existing live datasets should not be overwritten by old preview snapshots.

## Keep design concurrency separate from data concurrency

Use optimistic version checks for both, but independently.

Another agent publishing a layout should cause a layout conflict. A new temperature reading should not continually invalidate an unrelated layout draft.

A review certifies a design against recorded data snapshots and supported data constraints. It is not proof about every possible future value.

On publication, verify that the live datasets remain compatible with those constraints.

## Atomic does not mean simultaneous everywhere

The server’s publication is atomic. Client delivery is not.

Connected clients fetch the new revision and switch once its required resources are available. Offline clients retain the last usable revision and show that their information may be stale.

Likewise, **rolling back a design must not automatically roll back user data**. Restoring yesterday’s panel arrangement should not uncheck everything purchased today.

# 7. Make preview useful, not ceremonial

Use the production renderer for previews, with the same component versions, fonts, themes, and layout rules.

For web-based surfaces, I would use Playwright for browser execution, screenshots, viewport emulation, and interaction tests. Its documentation also notes that screenshot output depends on the execution environment, which is why preview environments should be controlled rather than treated as universally identical. ([Playwright][8])

Start with a modest test matrix: narrow phone, larger phone, and desktop. Add the Android WebView and native-widget checks as those clients become supported.

Do not send the model twenty nearly identical screenshots on every edit. Return an overview plus readable individual images for the affected targets, with additional detail available on demand.

## Test more than the current happy path

A shopping list that looks good with three short labels may fail with thirty items or one very long name.

Preview should exercise relevant states: empty data, ordinary data, long labels, many rows, missing values, and enlarged text.

Use component-specific measurement checks for overflow, invalid bindings, unusable controls, and runtime errors. Treat uncertain visual heuristics as warnings, not mathematical proof.

For example, a naïve “these rectangles overlap” test will incorrectly flag legitimate nested or layered UI.

Also test key interactions in a sandbox. A beautiful checkbox that updates the wrong item is still broken.

Preview interactions must not trigger real external actions.

## Separate enforceable checks from subjective judgment

The backend can enforce that the exact revision was rendered, required tests passed, and no blocking diagnostic remains.

It cannot prove that the model thoughtfully examined a screenshot or that every human would consider the result attractive.

An agent’s “looks good” acknowledgment is useful audit information, not a security boundary.

**Replace “the dashboard can never break” with a concrete engineering promise:**

> Unreviewed design changes never replace the live dashboard. Supported states are validated. Failures preserve a usable last-known presentation and expose a recovery path.

That is a promise an implementer can actually build toward.

## Bound the repair loop

Give the agent a retry or cost budget. When it cannot produce an acceptable design within that budget, keep the current publication and report the unresolved problem.

Do not publish the least-bad attempt simply because the loop ran out of patience.

# 8. Keep the dashboard stable as information changes

The agent should decide overflow behavior during design: pagination, “show more,” scrolling within a panel, compact summaries, or secondary pages.

Those policies allow ordinary data growth without requiring another design session.

When the user adds a new category of information, the agent should reconsider the whole composition. But it should not randomly rearrange everything on every refresh.

Store durable design intent alongside the layout: purpose, user-requested priority, explicit placement preferences, and why something was moved to a secondary view.

Imported content must not become design instructions. A shopping-item label is data, even when it contains text that resembles an instruction.

Most importantly:

**Preserving a clean dashboard must not become an excuse to silently delete information.**

The agent can reorganize or create secondary views. Removing user content or changing its retention policy requires appropriate authorization.

# 9. Handle actions without pretending MCP wakes agents by magic

There are two action paths.

## Dashboard-local actions

Checking an item in a dashboard-owned list should update stored data directly through a validated application action.

No model call is required.

The action should reference stable item IDs, carry an idempotency key, and obey version checks. Clients can display a pending state while it completes.

## External actions

Checking an item mirrored from an external shopping service should create an event for the harness:

```text
User checks item
       ↓
Dashboard records pending action
       ↓
Harness consumes the event
       ↓
Harness calls its shopping-service tool
       ↓
Harness reports success or failure
       ↓
Dashboard reconciles the displayed state
```

Until success is confirmed, the UI should not imply that the external service has been updated.

Use a durable event queue with acknowledgment, retry state, and deduplication. Assume events may be delivered more than once.

The dashboard does not call the external service directly.

## The autonomy boundary

MCP subscriptions provide notification delivery to participating clients. They do not, by themselves, guarantee that a host starts a new agent run in response. ([Model Context Protocol][9])

Therefore, distinguish these product modes:

**Interactive mode:** the user asks the agent to show or change something. A compatible MCP harness performs the workflow.

**Continuous mode:** the harness also supports scheduled or event-triggered execution, so it can refresh data and process external actions while the user is not chatting.

The second mode needs an explicitly supported harness execution mechanism. It does not necessarily need a separate skill, but a dashboard MCP server cannot manufacture that capability in an arbitrary host.

Do not hide this limitation by adding another LLM inside the dashboard service. That would undermine your original separation of responsibilities.

Similarly, a field named `"refresh": "live"` does nothing unless some authorized producer actually sends fresh data.

# 10. Implement this as one service, not a collection of microservices

Assuming an initially self-hosted, single-instance product, my starting stack would be:

| Area            | Initial choice                                                  |
| --------------- | --------------------------------------------------------------- |
| Backend         | TypeScript/Node with shared domain functions                    |
| Agent interface | Official MCP SDK and a remote MCP endpoint                      |
| Web rendering   | React, a project-owned catalogue, and json-render               |
| Preview         | Playwright worker using the production renderer                 |
| Persistence     | SQLite plus a persistent artifact directory                     |
| Android         | Kotlin shell with WebView; Glance for launcher widgets          |
| Client updates  | HTTP reads and an event stream, with reconnect/refetch behavior |

These are starting implementation choices, not requirements to support every deployment model.

The MCP handlers and client HTTP handlers should call the same application functions. **Do not create an internal HTTP hop merely because the diagram contains two boxes.**

Keep the preview worker isolated from request handling and give it CPU, memory, and execution limits. Initially, a database-backed job queue is enough. A preview request can return a job handle when necessary, and the same tool can retrieve its result.

Introduce PostgreSQL or a separate queue when deployment requirements justify them, not because every architecture diagram apparently owes Redis a cameo.

## Security belongs in the initial design

Separate client read/action permissions from agent edit/publish permissions. Enforce authorization on dashboards, datasets, revisions, screenshots, and assets.

Use the MCP authorization model for remote access through an established implementation rather than inventing a custom login protocol. ([Model Context Protocol][10])

Treat agent-authored documents and imported data as untrusted input. Validate component properties and bindings, escape text, sanitize supported rich text, and prohibit executable expressions or arbitrary action URLs.

Preview workers should not have access to external-service credentials or unrestricted network destinations. Prefer uploaded, access-controlled assets over arbitrary remote asset URLs.

Avoid exposing a broad native JavaScript bridge to dashboard content. Android’s security documentation specifically describes the risks of insecure WebView bridges. ([Android Entwickler][11])

Screenshots may contain health information or other private data. Apply access controls and retention rules to them just as you would to the underlying datasets.

# 11. Build the smallest complete loop first

The first milestone should not be a giant component catalogue.

**First, prove harness compatibility.** Connect the MCP server to a target harness, return an actual rendered image, and verify that the model can identify a visible issue and make a corrective tool call. This tests the central assumption before substantial investment.

**Then build one complete product slice.** Support a checklist and metric on a dashboard, draft editing, phone and desktop previews, guarded publication, and separate data updates.

**Then add the Android shell.** Verify the shared renderer on actual WebView targets, including offline recovery and cached publication behavior.

**Then add one native launcher-widget presentation.** A shopping-list widget is sufficient. Include its genuine native preview and action path rather than a browser approximation.

**Only then expand** the catalogue, charts, additional widget presentations, event-driven harness integrations, and richer terminal support.

The acceptance test should resemble your actual request:

> “Show my shopping list on the dashboard.”

The agent retrieves the list through its existing tools, inspects the existing dashboard, creates a draft, chooses a coherent phone and desktop composition, previews it, repairs any problems, and publishes.

After publication, checking an item updates data without rerunning the design loop.

Adding a new chart later causes the agent to review and rebalance the composition without silently discarding existing information.

A failed edit, crashed preview, stale review, or concurrency conflict leaves the live dashboard intact.

# Final architectural decision

**Build a persistent, agent-designed dashboard service, not a universal UI framework and not a second agent platform.**

Use **one MCP integration** for the existing harness. Give the agent a sufficiently expressive component catalogue and responsive composition controls. Share the main renderer between web and Android. Treat launcher widgets and terminal output as deliberately smaller presentations of the same data.

Keep **data changes independent from design changes**. Make preview evidence specific to the revision being published. Enforce correctness in the backend, preserve the last usable publication, and leave external integrations and autonomous execution with the harness.

That delivers your actual goal: **the user asks for information, the agent takes responsibility for its presentation, and the application makes that responsibility safe to exercise.**

[1]: https://json-render.dev/docs "Introduction | json-render"
[2]: https://developer.android.com/develop/ui/views/layout/webapps/webview "Build web apps in WebView  |  Android Developers"
[3]: https://developer.android.com/develop/ui/views/appwidgets "Create a basic widget  |  Views  |  Android Developers"
[4]: https://developer.android.com/develop/ui/views/appwidgets/overview "App widgets overview  |  Views  |  Android Developers"
[5]: https://modelcontextprotocol.io/specification/2026-07-28/server/tools "Tools - Model Context Protocol"
[6]: https://modelcontextprotocol.io/specification/2026-07-28/server/discover "Discovery - Model Context Protocol"
[7]: https://modelcontextprotocol.io/docs/extensions/apps "MCP Apps - Model Context Protocol"
[8]: https://playwright.dev/docs/test-snapshots "Visual comparisons | Playwright"
[9]: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions "Subscriptions - Model Context Protocol"
[10]: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization "Authorization - Model Context Protocol"
[11]: https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges "WebView – Native bridges  |  Security  |  Android Developers"

