# Opal Feature Explorer — Specification

A static single-page web app that displays the complete Opal feature graph and lets a user interactively select desired features to see the full set of required dependencies. The result is a tool that turns "what's our MVP?" from a recurring conversation into a concrete, scoped, exportable artifact.

---

## 1. Purpose

Show every potential Opal feature — MVP, Phase 2, Phase 3, endgame — in a single dependency graph. Let the user click any feature to add it to a working scope. The page automatically includes every transitive dependency and shows what additional features would be unlocked next. The user ends up with a defensible MVP definition, expressed as a list of nodes, that they can save, share, or hand to a build team.

Two audiences:

- **Founder / strategy** — exploring tradeoffs, comparing candidate scopes, rehearsing the pitch.
- **Build team** — receiving a concrete list of modules with explicit dependencies, ready to plan against.

---

## 2. Data

All graph data lives in `opal_feature_graph.json` (sibling file). The shape:

```ts
type Layer = 'external' | 'foundation' | 'capture' | 'workflow'
            | 'conversion' | 'policy' | 'contracting' | 'reporting'
            | 'agency' | 'network';

type Category = 'core' | 'feature' | 'integration' | 'ui';

type EdgeType = 'hard' | 'soft' | 'progresses';

interface Node {
  id: string;             // kebab-case, stable, used in URLs and saved scopes
  title: string;          // 1-3 words, the visible label
  subtitle: string;       // 4-6 words, brief tagline shown under title
  description: string;    // 1-2 sentences, longer text for tooltip / panel
  layer: Layer;           // which swim-lane the node sits in
  category: Category;     // tag for filtering
  weight: 1 | 2 | 3 | 4 | 5;  // complexity / cost estimate
  mvpCandidate: boolean;  // hint for the "Lean MVP" preset
}

interface Edge {
  from: string;           // node id (the dependent)
  to: string;             // node id (the dependency)
  type: EdgeType;
  rationale?: string;     // optional explanation for tooltip
}

interface LadderTier {
  tier: number;           // 0, 1, 2, 3...
  node: string;           // node id at this tier
  label: string;          // short display label for the ladder view
}

interface Ladder {
  id: string;
  title: string;          // capability dimension name
  description: string;
  tiers: LadderTier[];    // ordered low-to-high
}

interface Preset {
  id: string;
  title: string;
  description: string;
  selected: string[];     // node ids to start with selected
}
```

The current graph contains **71 nodes**, **144 edges**, **10 layers**, **8 maturity ladders**, and **4 presets**. No cycles (validated DAG).

### Edge direction convention

`from` depends on `to`. Read every edge as: "`from` requires `to` to exist." Dependency arrows in the visual point from the dependent toward its dependency.

### Edge types

- **Hard** — the from-node literally cannot function without the to-node. Selection MUST include all transitive hard deps.
- **Soft** — the from-node is meaningfully better with the to-node, but works alone. SUGGEST in side panel; do not auto-include.
- **Progresses** — the from-node is the next maturity tier of the same capability as the to-node, and requires the previous tier as a prerequisite. Behaves identically to `hard` for dependency math (auto-includes transitively), but renders distinctly in the ladder view (see §4).

Example of all three:

- `eapp-native → eapp-middleware` is `progresses` — Tier 3 carrier integration requires Tier 2 to exist first.
- `eapp-native → contact-model` is `hard` — without the data spine, no module functions.
- `eapp-extension → quote-comparison` is `soft` — autofill is more useful when a quote selection drives carrier choice, but it works without one.

### Maturity ladders

`ladders` is a top-level array describing capability progressions explicitly. Each ladder names a capability dimension (e.g., "Carrier integration", "Quote depth") and lists the nodes that represent each tier of that capability, low-to-high.

The ladder view (§4) reads from this array directly. The `progresses` edges in the graph reflect the same relationships in dependency form, but the ladder array is what drives the alternate visualization. Keeping them separate means edits to one don't silently invalidate the other.

The eight current ladders: carrier integration, UW intelligence, quote depth, capture intelligence, lead intake automation, reporting depth, commission handling, dialer throughput.

---

## 3. Architecture view (default layout)

The default view shows the full graph as **horizontal swim-lanes**, one per layer, stacked top-to-bottom in the order defined in `layers[].order`. Within a swim-lane, nodes flow left-to-right in declaration order. This gives stable, predictable positions without any layout engine.

### Constants

```
NODE_WIDTH      = 168
NODE_HEIGHT     = 60
NODE_GAP_X      = 16
NODE_GAP_Y      = 28
LANE_PADDING_Y  = 32   // top padding inside each lane
LANE_LABEL_W    = 120  // left gutter for the lane label
CANVAS_PADDING  = 32
NODES_PER_ROW   = 6    // wrap to a second row inside a lane after this
```

### Per-lane layout

For each lane, lay out nodes in rows of up to `NODES_PER_ROW`. If a lane has more than 6 nodes (capture has 12, workflow has 14), it wraps to 2 or 3 rows. Lane height grows to fit.

```
laneHeight(lane) = LANE_PADDING_Y * 2
                 + ceil(lane.nodeCount / NODES_PER_ROW) * NODE_HEIGHT
                 + (rows - 1) * NODE_GAP_Y

node.x = LANE_LABEL_W + CANVAS_PADDING + (col * (NODE_WIDTH + NODE_GAP_X))
node.y = laneTop + LANE_PADDING_Y + (row * (NODE_HEIGHT + NODE_GAP_Y))
```

Lane labels sit at `x = CANVAS_PADDING, y = laneTop + LANE_PADDING_Y` in 12px secondary text, all caps tracking-wide.

### Edges

Edges render as SVG paths between node anchors. Anchor logic:

- If `from` and `to` are in different lanes, anchor `from` at its bottom-center and `to` at its top-center. Use a cubic Bezier with a vertical control offset: `M x1 y1 C x1 (y1+40), x2 (y2-40), x2 y2`.
- If they're in the same lane, anchor side-to-side and route with a small downward dip.

Hard edges: solid stroke 1px. Soft edges: dashed `4 4` 0.5px, 60% opacity. Progresses edges: dashed `6 3` 0.75px (see §5 for full edge state table).

### Performance note

144 edges and 71 nodes is small. A naive full-graph rerender on every state change is fine; no need for virtualization, canvas, or WebGL. Plain SVG is correct.

---

## 4. Ladder view (alternate layout)

A toggle in the top-right of the canvas switches between the architecture view and the **ladder view**, which reorganizes the same graph by capability dimension instead of by architectural layer. The ladder view is driven by the `ladders[]` array in the graph JSON.

### Layout

Each ladder is one horizontal row. Within a row, the tier nodes are arranged left-to-right in tier order. A row label sits in the left gutter showing the capability name.

```
LADDER_LABEL_W    = 110
TIER_NODE_WIDTH   = 100
TIER_NODE_HEIGHT  = 50
TIER_GAP_X        = 16
LADDER_GAP_Y      = 24
LADDER_PADDING_Y  = 28
```

A column-header strip at the top labels Tier 1, Tier 2, Tier 3, etc. up to the maximum tier across all ladders. Cells in tier columns where a given ladder has no entry are left empty.

```
node.x = LADDER_LABEL_W + (tier - minTier) * (TIER_NODE_WIDTH + TIER_GAP_X)
node.y = laddersTop + ladderIndex * (TIER_NODE_HEIGHT + LADDER_GAP_Y)
```

Within each row, draw arrows between consecutive tier nodes (Tier N → Tier N+1) using the `progresses` edge style. The arrows ARE the visual story of the ladder.

### Selection in ladder view

Nodes in the ladder view are the same nodes as in the architecture view. Selecting a tier-3 node still pulls in its full transitive dependencies (which often span layers and other ladders) — the ladder view doesn't change the dependency math, it just re-arranges the canvas.

### Interaction with architecture view

Toggling between views animates a `transform` on each node from its architecture-view coordinates to its ladder-view coordinates (or vice versa). Use a 320ms cubic-bezier ease. Nodes that exist in only one view (most nodes are not part of any ladder) fade out / in over 200ms during the transition. Edges fade out and re-render at the new positions; don't try to animate edge paths.

Selection state and side panel content do not change on toggle.

### Why two views

The architecture view answers "what does this scope architecturally look like — what's in foundation, what's in workflow, etc." The ladder view answers "for each capability dimension, how deep are we going?" Both questions matter when scoping. Most users will pick one tier per ladder that's right for their scope, plus additional features that don't sit on any ladder. Toggling between views surfaces gaps: if your scope includes Tier 3 for everything but Tier 1 for carrier integration, the ladder view makes that imbalance obvious in a way the architecture view doesn't.

---

## 5. Visual design

The page uses a flat, neutral aesthetic — closer to a build tool than a marketing page. Light mode and dark mode are both first-class.

### Color tokens

Use CSS variables so dark mode is one media query:

```css
:root {
  --bg:          #FAFAF7;
  --bg-elev:     #FFFFFF;
  --text:        #1A1A18;
  --text-muted:  #888780;
  --text-faint:  #B4B2A9;
  --border:      #D3D1C7;
  --border-hi:   #888780;

  --accent:        #534AB7;  /* selected — purple 600 */
  --accent-fill:   #EEEDFE;  /* selected fill — purple 50 */
  --required:      #BA7517;  /* required — amber 600 */
  --required-fill: #FAEEDA;  /* required fill — amber 50 */
  --unlocks:       #1D9E75;  /* unlocks — teal 600 */
  --unlocks-fill:  #E1F5EE;  /* unlocks fill — teal 50 */
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg:          #1A1A18;
    --bg-elev:     #2C2C2A;
    --text:        #F1EFE8;
    --text-muted:  #B4B2A9;
    --text-faint:  #5F5E5A;
    --border:      #444441;
    --border-hi:   #888780;

    --accent:        #AFA9EC;
    --accent-fill:   #3C3489;
    --required:      #FAC775;
    --required-fill: #633806;
    --unlocks:       #5DCAA5;
    --unlocks-fill:  #085041;
  }
}
```

### Node states

Every node is in exactly one of these states at any time. The state determines fill, stroke, and text color:

| State        | Fill              | Stroke              | Title color   | Description                           |
|--------------|-------------------|---------------------|---------------|---------------------------------------|
| `available`  | transparent       | `--border` 0.5px    | `--text`      | Default. Not part of current scope.   |
| `selected`   | `--accent-fill`   | `--accent` 1.5px    | `--accent`    | User clicked it. Part of scope.       |
| `required`   | `--required-fill` | `--required` 1px    | `--required`  | Pulled in by transitive dependency.   |
| `unlocks`    | transparent       | `--unlocks` dashed  | `--unlocks`   | Adjacent — would unlock if selected.  |
| `dimmed`     | transparent       | `--border` 0.5px    | `--text-faint`| When a filter is active.              |

`hovered` is overlaid: stroke goes 2px regardless of underlying state.

### Edge states

| State              | Stroke           | Width  | Dash     | Opacity |
|--------------------|------------------|--------|----------|---------|
| `idle`             | `--border`       | 0.5px  | solid    | 0.4     |
| `idle-soft`        | `--border`       | 0.5px  | 4 4      | 0.25    |
| `idle-progresses`  | `--text-muted`   | 0.75px | 6 3      | 0.5     |
| `active-required`  | `--required`     | 1px    | solid    | 0.9     |
| `active-soft`      | `--unlocks`      | 0.5px  | 4 4      | 0.7     |
| `active-progresses`| `--required`     | 1px    | 6 3      | 0.9     |
| `feeds-selected`   | `--accent`       | 1px    | solid    | 0.9     |

Progresses edges always render with their distinctive `6 3` dash pattern so the maturity ladder is recognizable in the architecture view. They behave identically to hard edges for the dependency math.

### Typography

- Sans-serif system stack: `system-ui, -apple-system, "Segoe UI", "Helvetica Neue", sans-serif`
- Node title: 13px, weight 500
- Node subtitle: 10px, weight 400, `--text-muted`
- Lane label: 11px, weight 500, `--text-faint`, `letter-spacing: 0.08em`, uppercase
- Side panel heading: 17px, weight 500
- Side panel body: 13px, weight 400, line-height 1.5

No headings above 17px anywhere. Resist any urge to make this look like a SaaS landing page — it's a tool.

### Animation

- Node state transitions: 180ms ease, fill + stroke + color
- Edge state transitions: 180ms ease, stroke + opacity
- Side panel content updates: fade 120ms
- No bounce, no spring, no slow ease-out beyond 180ms. Speed reads as quality here.

Respect `prefers-reduced-motion: reduce` by clamping all transitions to 0ms.

---

## 6. Interaction model

### Selection

- **Click a node** → toggle its `selected` state.
- **Cmd/Ctrl-click** → in v2, multi-toggle without dropping focus on previous selection (irrelevant for v1; toggle is already idempotent).
- **Hover a node** → highlight its immediate dependencies (orange) and immediate dependents (teal) and connecting edges. Releasing hover returns to current selection state.
- **Esc** → clear all selection.

### Derived state

When the `selected` set changes, recompute:

- `requiredSet` = transitive closure of `hard` edges out of every selected node. (BFS up the graph, following `from→to` along hard edges.)
- `unlocksSet` = direct `from`-side neighbors of any node in `selected ∪ required`, where the neighbor itself isn't already in `selected ∪ required`.
- `softSuggestions` = direct `to`-side soft-edge neighbors of any node in `selected ∪ required`. Shown as muted teal hints in the side panel.

### Pseudocode

```js
// hard and progresses both auto-include transitively
const REQUIRED_TYPES = new Set(['hard', 'progresses']);

function recompute(state) {
  const required = new Set();
  for (const id of state.selected) {
    bfs(id, REQUIRED_TYPES, edge => required.add(edge.to));
  }

  const inScope = new Set([...state.selected, ...required]);

  const unlocks = new Set();
  for (const id of inScope) {
    for (const e of edgesByTo.get(id) || []) {
      if (!inScope.has(e.from)) unlocks.add(e.from);
    }
  }

  const softSuggestions = new Set();
  for (const id of inScope) {
    for (const e of edgesByFrom.get(id) || []) {
      if (e.type === 'soft' && !inScope.has(e.to)) softSuggestions.add(e.to);
    }
  }

  return { selected: state.selected, required, unlocks, softSuggestions };
}

function bfs(startId, edgeTypes, visit) {
  const seen = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    for (const e of edgesByFrom.get(id) || []) {
      if (!edgeTypes.has(e.type)) continue;
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      visit(e);
      queue.push(e.to);
    }
  }
}
```

Index `edgesByFrom` and `edgesByTo` once at load time as `Map<NodeId, Edge[]>`.

### URL state

Selection persists in the URL hash as a comma-separated id list:

```
https://opal-explorer.example.com/#auth,contact-model,activity-log,...
```

On load, parse the hash and restore. On change, debounce (200ms) and replace history. Sharing the URL shares the selection — that's the whole feature.

### LocalStorage

In addition to the URL, persist the last-active selection to `localStorage['opal-explorer-selection']` so a fresh tab restores. URL takes precedence if present.

---

## 7. Side panel ("Scope drawer")

A fixed-width drawer on the right of the canvas. Width: 360px. Always visible on desktop; collapses behind a button on narrow screens (<900px viewport).

### Sections, top to bottom

1. **Header.** "Scope picker" + a small "Reset" link.
2. **Counts strip.** Three pill-counters: `Selected · 12`, `Auto-included · 8`, `Total · 20`.
3. **Selected list.** All nodes the user explicitly clicked. Each row: title, subtitle, (×) to remove. Rows grouped by lane with a small lane label divider.
4. **Auto-included.** All `required` nodes. Same row format but no remove button — these are forced. A small "(why?)" hover reveals which selected node pulled it in (the shortest path).
5. **Unlocks next.** First 6 nodes from `unlocksSet`, sorted by how many of their own dependencies are already in scope (closest-to-ready first). One-click-add buttons. "Show all" expands the rest.
6. **Soft suggestions.** Small section: "Better with: …" listing `softSuggestions`, ghost styling, click to add.
7. **Stats.** Sum of `weight` for all in-scope nodes, plus a bucket label:
   - 1–25 weight = **Lean** (single squad, ~3 months)
   - 26–60 weight = **Standard** (small team, ~6 months)
   - 61–110 weight = **Large** (multi-squad, ~12 months)
   - 110+ weight = **Platform** (full company effort, 18+ months)
   These are deliberately rough. Add a tiny "rough estimate" disclaimer.
8. **Actions.**
   - `Load preset →` opens preset picker (see §8).
   - `Export JSON` downloads `opal-scope-<date>.json` with the current selection plus computed required + metadata.
   - `Copy share link` copies the URL to clipboard.

### Empty state

When nothing is selected, show: "Click any module to start scoping." with a "Try the Lean MVP preset" button.

---

## 8. Presets

Loading a preset replaces the current `selected` set with the preset's list. Show a confirmation if there's an existing non-empty selection.

The four shipped presets are defined in `opal_feature_graph.json` under `presets`:

1. **Lean MVP** — populated with the 26 nodes flagged `mvpCandidate: true`. The "no carrier dependency" producer-installable scope.
2. **Full agent workspace** — Lean MVP plus advanced capture, full quoting suite, commission tracking, personal analytics. ~50 nodes.
3. **Agency / IMO edition** — adds multi-tenant, override tracking, recruiting, white-label. (Selection list intentionally empty in the JSON; v2 should populate it.)
4. **Industry platform** — everything. Selecting all 70 should naturally produce this; the preset just clicks "select all."

Presets are non-binding. After loading, the user can add or remove freely.

---

## 9. Filters (v1.5 if time)

A small filter row above the canvas:

- **Layer chips** — toggle each lane's visibility. Hidden lanes still affect dependency math; they just render dimmed.
- **Category chips** — `core`, `feature`, `integration`, `ui`.
- **Search** — fuzzy match on title + subtitle + description. Matching nodes get a temporary glow; non-matches go to `dimmed`.

Filtering never modifies selection. It's a view filter only.

---

## 10. Tech stack

This page is small enough that **vanilla HTML/CSS/JS with no build step** is the right choice. Single `index.html`, a single `style.css`, a single `app.js`, plus the JSON file. Host on GitHub Pages, Cloudflare Pages, Vercel, or any static server.

If preferred, **Vite + React** is also fine and adds reasonable dev ergonomics. Don't reach for Next.js or anything with SSR — there's nothing to render server-side.

### Libraries

- **None required.** The whole thing is plain DOM + SVG manipulation.
- Optional: **lucide** icons (CDN) for the side panel buttons.
- Avoid: D3 force layout (unpredictable; the swim-lane grid is better), Cytoscape (overkill), React Flow (designed for editable graphs; overkill).

### Browser targets

Modern evergreen: Chrome 110+, Safari 16+, Firefox 110+. No IE, no legacy Edge. Use `:has()` and CSS nesting freely.

---

## 11. File structure

```
opal-explorer/
├── index.html              # Single page; <main> for canvas, <aside> for drawer
├── style.css               # All styles + dark mode
├── app.js                  # Load JSON, layout, interaction, recompute
├── opal_feature_graph.json # Data (this repo's sibling file)
└── README.md               # How to run + how to edit the graph
```

Suggested `app.js` outline:

```
- loadGraph() → fetch JSON, build edgesByFrom / edgesByTo indexes
- layout() → assign x,y to every node; compute SVG canvas size
- render() → render lanes, nodes, edges, side panel from current state
- recompute() → derive required / unlocks / softSuggestions from selected
- onNodeClick(id), onNodeHover(id), onPresetLoad(id), onReset(), onExport()
- syncUrl(), readUrl(), syncStorage(), readStorage()
```

Keep state as a single object:

```js
const state = {
  graph: null,            // loaded from JSON
  selected: new Set(),
  hoveredId: null,
  filter: { layers: new Set(), categories: new Set(), search: '' },
  derived: { required: new Set(), unlocks: new Set(), softSuggestions: new Set() }
};
```

`recompute()` is called whenever `selected` or `graph` changes. `render()` reads from `state` only — no other source of truth.

---

## 12. Editing the graph

The JSON file is the canonical source. To add a new feature:

1. Append a new node to `nodes[]` with a unique kebab-case `id`.
2. Add edges from the new node to its hard and soft dependencies.
3. Optionally add edges from existing nodes to the new one (if it's a dependency *of* something).
4. Reload the page. Layout regenerates automatically.

To verify the graph is still a DAG after edits, run the validation snippet in the README (BFS-based cycle check on hard edges).

---

## 13. Acceptance criteria

The v1 page is done when:

- [ ] All 71 nodes render in their correct lanes, in declaration order, without overlap.
- [ ] All 144 edges render with correct hard/soft/progresses styling and connect the right nodes.
- [ ] The ladder view toggle reorganizes the canvas into 8 tier-based rows with smooth transitions.
- [ ] Progresses edges are visually distinct (dashed `6 3` pattern) but auto-include their `to`-side dependencies just like hard edges.
- [ ] Clicking a node toggles selection and triggers a full recompute in <50ms.
- [ ] Selecting a node visibly updates required, unlocks, and edge states with smooth (180ms) transitions.
- [ ] Hovering a node temporarily highlights its immediate neighbors and connecting edges.
- [ ] Side panel always shows: counts, selected list, required list with reason, unlocks list, soft suggestions, weight stats.
- [ ] Loading the "Lean MVP" preset selects exactly the 26 `mvpCandidate: true` nodes and produces no additional `required` (since MVP is dependency-closed by design — verify this is the case after load; if not, the candidate flags need updating).
- [ ] URL hash reflects current selection and is restorable from a cold tab.
- [ ] Export JSON produces a file containing `selected`, `required`, `total weight`, and the timestamp.
- [ ] Dark mode renders correctly via `prefers-color-scheme`.
- [ ] Page loads (excluding fonts) in under 200ms on a fast connection. The whole thing should feel instant.

---

## 14. Future / not in v1

- Drag-to-reposition nodes (and persist positions).
- User-added comments / notes per node (Markdown, persisted to localStorage or backend).
- Multi-user shared scopes (would require a backend; out of scope for static page).
- Per-node estimated dollar cost rollup.
- Automatic critical-path highlighting from a goal node down to roots.
- Diff mode (compare two saved scopes side by side).
- "Scope receipts" — generate a clean printable / PDF summary of a scope.

These can come later. The v1 must ship the dependency picker and nothing more.
