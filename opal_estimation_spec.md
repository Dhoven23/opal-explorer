# Opal Estimation & Gantt Spec

A lean approach to per-module build-time and cost estimates, plus the Gantt view that consumes them. Pairs with `opal_explorer_spec.md` and `opal_feature_graph.json`.

---

## 1. Estimation philosophy

Three rules:

- **One number plus a range.** Each module has `devWeeksLow / devWeeksExpected / devWeeksHigh`. Don't pretend you know more precisely than that.
- **Rule first, override second.** A weight-based default rule populates every module. Override only the ~10 modules where the rule is wrong, and write down *why* in the node's `effort.notes`.
- **Calendar weeks come from the schedule, not the estimate.** A module's `devWeeksExpected` is the work content. How long it takes on the calendar depends on team size, parallelization, and the dependency graph — that's the Gantt's job.

The goal is a budget that's defensible at the order-of-magnitude level, not a Gantt that holds up to 5% scrutiny. If the picker says "this scope is ~$2.5M and ~12 months," that's enough to make a build-vs-not-build call and to talk to investors.

---

## 2. Schema additions

Each node gets an `effort` object:

```ts
interface NodeEffort {
  devWeeksLow: number;           // ~P10 — best plausible case
  devWeeksExpected: number;      // ~P50 — what you'd plan around
  devWeeksHigh: number;          // ~P90 — bad-case, before "we should pivot"
  teamSize: 0 | 1 | 2 | 3;       // concurrent engineers needed at peak
  costUsdExpected: number;       // computed: devWeeksExpected * teamSize * usdPerDevWeek
  externalCostsUsd?: number;     // licenses, data acquisition, partnerships
  notes?: string;                // gotchas, what was overridden, what scales
}
```

And a top-level `costModel`:

```ts
interface CostModel {
  usdPerDevWeek: number;         // default 10000 — fully-loaded blended weekly rate
  description: string;
}
```

`costUsdExpected` is denormalized into the JSON so consumers don't have to know the multiplier; if you change the rate, recompute and re-save.

---

## 3. Default rule

Every module starts with this rule, applied at JSON-build time:

```
weight 1 → 1 / 2  / 3  dev-weeks  · teamSize 1
weight 2 → 3 / 4  / 6              · teamSize 1
weight 3 → 6 / 8  / 12             · teamSize 1
weight 4 → 12/ 16 / 24             · teamSize 2
weight 5 → 24/ 32 / 48             · teamSize 2
```

Then multipliers stack:

| Trigger                                                     | Multiplier on expected |
|-------------------------------------------------------------|------------------------|
| `category === 'integration'`                                | × 1.30                 |
| `category === 'core'`                                       | × 1.20                 |
| Description mentions AI/ML/predictive/transcript/STT        | × 1.40                 |
| Description mentions compliance/regulator/HIPAA/CMS/two-party| × 1.15                |

The high estimate gets an additional × 1.10 on top of multipliers, because the right tail is fatter than the left.

This rule produces reasonable numbers for ~85% of nodes and clearly-wrong numbers for the rest. The clearly-wrong ones get overrides.

### External nodes

Any node with `layer === 'external'` gets `effort = { all zeros, teamSize: 0, notes: "External system — not built by Opal." }`. These aren't work items; they're acknowledged dependencies. The Gantt excludes them from the chart entirely.

---

## 4. Overrides — where the rule lies

Eleven modules currently override the rule. Each override exists for a real reason; if you copy the pattern for new nodes, write the reason in `notes`.

| Module                   | Why override                                                                 |
|--------------------------|------------------------------------------------------------------------------|
| `eapp-extension`         | Per-carrier work; estimate covers ~10 high-volume carriers, ~1-2 weeks each. |
| `eapp-native`            | Per-carrier; estimate is per carrier, not aggregate. Gated on API access.    |
| `eapp-middleware`        | Per-carrier-list via aggregator.                                             |
| `carrier-end-to-end`     | Per-carrier cost. Most expensive single line in the system.                  |
| `carrier-api-spec`       | Standards/coordination work, not pure engineering.                           |
| `lead-exchange`          | Includes payments, escrow, dispute resolution — marketplace dynamics dwarf eng.|
| `rx-prequal`             | $50-100K external for prescription dataset; model improves with submission volume. |
| `multi-tenant`           | Foundational refactor; 3x cost to retrofit later.                            |
| `industry-data`          | Compliance, contracts, partner agreements drive the cost.                    |
| `commission-recon`       | Carrier statement formats are wildly inconsistent; long tail of edge cases.  |
| `illustration-gen`       | Per-carrier compliance review cycle.                                         |

### "Per-carrier" is not "total"

For `eapp-native`, `carrier-end-to-end`, and `eapp-middleware`, the listed estimate is **per carrier integration**, not a total. If the scope includes integrating with 20 carriers, multiply. The picker should surface a "carrier count" input that scales these specific modules. (v2 feature; for v1, just note this in the side panel when one of those modules is selected.)

---

## 5. Cost rollup

Two views of cost in the side panel:

**Naive sum** — `Σ effort.costUsdExpected + Σ externalCostsUsd` for everything in scope (selected + required). This is the *content* cost — total work to be done. It overstates calendar burn because it ignores parallelization.

**Calendar burn** — `criticalPathWeeks × peakTeamSize × usdPerDevWeek + Σ externalCostsUsd`. This estimates what you'll actually spend cash on if you maintain a team large enough to keep the critical path moving. It's typically 60-80% of the naive sum for well-parallelized scopes.

Show both with their definitions. Investors and CFOs ask different questions; the naive sum is "total content," the calendar burn is "burn rate × time."

For the Lean MVP preset (27 modules), the current numbers are:

- Naive sum: 221 dev-weeks · ~$2.66M (no externals)
- Critical path (single-engineer-per-module): 50 weeks
- ~$220K/month at peak team capacity

A more aggressive team configuration (parallel work on critical-path modules) can compress this to ~36-40 weeks. A leaner team stretches it to ~60+ weeks but at lower monthly burn.

---

## 6. Gantt view — scheduling algorithm

The Gantt view is one of three views toggled at the top of the canvas, alongside the architecture view and ladder view (see `opal_explorer_spec.md` §3 and §4). All three share the same selection state — switching views never changes scope.

### Inputs

```
selected: Set<NodeId>           // user clicks
required: Set<NodeId>           // transitive hard+progresses deps
inScope = selected ∪ required
edges: Edge[]                   // hard, progresses, soft
nodes: Node[]                   // each carries effort
teamSize: number                // user-set; v1 default = "infinite" (one engineer per module)
```

### Algorithm — earliest-start scheduling

```js
function scheduleGantt(inScope, edges, nodes) {
  const REQUIRED_TYPES = new Set(['hard', 'progresses']);
  const depsOf = new Map();   // nid -> Set of dependency ids in scope
  for (const id of inScope) depsOf.set(id, new Set());
  for (const e of edges) {
    if (!REQUIRED_TYPES.has(e.type)) continue;
    if (!inScope.has(e.from) || !inScope.has(e.to)) continue;
    depsOf.get(e.from).add(e.to);
  }

  const start = new Map();
  const end = new Map();
  function compute(nid) {
    if (end.has(nid)) return;
    for (const d of depsOf.get(nid)) compute(d);
    const s = Math.max(0, ...[...depsOf.get(nid)].map(d => end.get(d)));
    const dur = nodes.find(n => n.id === nid).effort.devWeeksExpected;
    start.set(nid, s);
    end.set(nid, s + dur);
  }
  for (const id of inScope) compute(id);

  return { start, end, totalWeeks: Math.max(...end.values()) };
}
```

This is **infinite-resource scheduling**: each module gets its own engineer the moment its dependencies are met. v1 ships with this. It produces the *minimum possible* duration given the dependency graph — the lower bound the team can target.

### v2 — resource-constrained scheduling

Add a team-size constraint. When more than `teamSize` modules want to be active in the same week, queue the surplus by priority (modules on the critical path go first; ties broken by descending duration). This is bin-packing on a list scheduler — straightforward but not in v1. The lower-bound vs constrained-bound difference is itself a useful number to surface in the side panel.

### Critical path

After computing `end`, find the node with maximum `end` and trace back through `depsOf`, at each step picking the dep with the highest `end`. The resulting node sequence is the critical path. Highlight every node on this path in the Gantt with a thicker bar stroke.

---

## 7. Gantt view — layout

### Constants

```
WEEK_PX           = 8        // pixels per week
LABEL_COL_W       = 200      // module-name column on the left
CHART_LEFT        = 200
ROW_H             = 24
BAR_H             = 18
BAR_PAD_TOP       = 3
HEADER_H          = 50       // weeks + phase labels
FOOTER_H          = 50       // critical path summary + legend
```

Total chart width = `LABEL_COL_W + totalWeeks × WEEK_PX`. For the Lean MVP (50 weeks): `200 + 50 × 8 = 600`. Fits in 680 with a small right margin for the totals readout.

### Row order

Sort rows by:

1. Layer order (foundation, capture, workflow, conversion, policy, contracting, reporting, agency, network).
2. Within layer: ascending start week.

This preserves architectural meaning *and* shows scheduling order. Nodes from the same layer sit next to each other; within a layer, the earliest-starting one is on top.

### Bar styling

- **Fill:** lane color at the 50 stop (light) — same as the architecture view's available state.
- **Stroke (default):** lane color at the 600 stop, 0.5px.
- **Stroke (critical path):** same color, 1.5px. No color change — the thicker stroke reads as "structural" without competing with the layer color encoding.
- **Stroke (in `required` but not `selected`):** dashed `4 4` instead of solid, so you can see at a glance which bars are auto-included vs explicitly chosen.
- **Bar height:** 18px (so consecutive rows have 6px of breathing room).
- **Bar corner radius:** 3px.

### Weekly grid

Vertical guide lines at every 8 weeks (week 0, 8, 16, ...) at 0.2 opacity. Phase markers (vertical dashed lines) at the boundaries between Foundation, Build, and Polish phases — derived heuristically as "first week any non-foundation node starts" and "first week any policy/post-sale node starts" respectively. These are decorative orientation cues, not data.

### Header

Three rows above the bars:

1. Phase labels (Foundation / Build / Polish) at the top, centered over their phase ranges in muted text.
2. Week numbers every 8 weeks.
3. A 1px hairline separator at the top of the bar area.

### Footer

1. **Critical path summary line:** `★ Critical path: NN wk — node1 → node2 → node3 → ...` at the left, in muted text with the star marker.
2. **Layer legend:** small color swatches with labels (only for layers actually present in the current scope).
3. **Totals readout:** at the right, `≈ N modules · M dev-wk · ~$X.XM`.

### Dependency arrows

Optional, off by default. In v1.5, add a toggle to show finish-to-start arrows from the right edge of each predecessor bar to the left edge of its dependent. Use 0.5px lines with the arrow marker. Only show arrows for hard+progresses edges (soft would clutter).

When the user *hovers* a bar, always show the arrows in/out of that bar regardless of the toggle.

---

## 8. Interaction

The Gantt is a view of the same `state` as the other views. Toggling between architecture / ladder / Gantt animates a layout transition; selection state, side panel, and URL hash are unchanged.

**Hover a bar** → highlight the module + all upstream bars on its critical path back to the foundation, plus a tooltip with: layer, dev-weeks (low/expected/high), team size, expected cost, and any `notes`.

**Click a bar** → toggle selection (same as architecture view). The Gantt rerenders because removing/adding a node may shift the schedule.

**Team-size slider** (top-right of canvas, v2): values 1, 2, 5, 10, ∞. Re-runs the scheduler under that constraint. Shows two numbers in the footer: "ideal: NN wk · constrained: MM wk" so the user sees how much they're paying for being team-constrained.

**Confidence toggle** (top-right of canvas): radio between Low / Expected / High. Re-runs the scheduler with that confidence band. Default is Expected. Switching to High shows what the schedule looks like in a P90 outcome — usually 40-60% longer.

**Export Gantt as CSV** — one row per module: `id, title, layer, start_week, end_week, duration_weeks, team_size, cost_usd, on_critical_path, notes`. The full schedule, in spreadsheet-paste-able form. The same export button as in the architecture view's side panel; just adds Gantt-specific columns when the Gantt view is active.

---

## 9. Editing estimates

Estimates live in the JSON. Three ways to update:

1. **Tweak the default rule.** Edit `WEEKS_BY_WEIGHT` and the multiplier table in the seed script that populates the JSON. Re-run, regenerate. Affects all rule-based nodes.
2. **Add an override.** Set `effort` directly on a node in the JSON. The override always wins.
3. **Change the cost rate.** Edit `costModel.usdPerDevWeek` and recompute `costUsdExpected` for every node.

There's no UI for editing estimates in v1. They're authored values. If you want users to adjust estimates interactively, that's a v2 feature with its own design problem (per-user overlays, shared edits, version history).

---

## 10. Acceptance criteria

The Gantt view is done when:

- [ ] All 71 nodes have a populated `effort` object in the JSON.
- [ ] External nodes have `effort.devWeeksExpected = 0` and are excluded from the Gantt chart.
- [ ] Toggling to the Gantt view animates a layout transition; selection state and side panel are preserved.
- [ ] Bars render in correct earliest-start positions for the current `inScope`.
- [ ] Critical path is computed and bars on it have a 1.5px stroke; off-path bars have 0.5px.
- [ ] Required-but-not-selected bars have a dashed stroke pattern.
- [ ] Footer shows the critical path summary, layer legend, and totals (modules / dev-weeks / cost).
- [ ] Hovering a bar shows a tooltip with layer, effort range, team size, cost, and notes.
- [ ] Loading the Lean MVP preset produces a schedule with ~50-week critical path, 27 bars, $2.66M total cost (roughly — exact numbers depend on edits to the rule).
- [ ] Switching between confidence bands (Low / Expected / High) re-renders the schedule.
- [ ] CSV export produces one row per scheduled module with the columns listed in §8.

---

## 11. Future / not in v1

- Team-size slider (resource-constrained scheduling).
- Per-engineer or per-team swim lanes (assigning modules to people).
- Real calendar dates instead of week numbers (with a project start date input).
- Holiday and PTO buffers.
- Carrier-count multiplier for `eapp-extension`, `eapp-native`, `eapp-middleware`, `carrier-end-to-end`.
- Risk-weighted cost (Monte Carlo over the L/E/H ranges).
- Burndown overlay for in-flight projects.
- Diff between two scoped Gantts (same picker, two scopes — show what the larger scope adds in time and money).

The v1 ships the schedule, the chart, the critical path, the cost rollup, and the CSV export. That's enough to make scoping decisions defensible.
