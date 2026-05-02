// Opal Feature Explorer — vanilla DOM + SVG.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Architecture view constants
const NODE_WIDTH = 168;
const NODE_HEIGHT = 60;
const NODE_GAP_X = 16;
const NODE_GAP_Y = 28;
const LANE_PADDING_Y = 32;
const LANE_LABEL_W = 120;
const CANVAS_PADDING = 32;
const NODES_PER_ROW = 6;

// Ladder view constants
const LADDER_LABEL_W = 110;
const TIER_NODE_WIDTH = 100;
const TIER_NODE_HEIGHT = 50;
const TIER_GAP_X = 16;
const LADDER_GAP_Y = 24;
const LADDER_PADDING_Y = 28;
const LADDER_HEADER_H = 28;

// Hard + progresses both auto-include transitively.
const REQUIRED_TYPES = new Set(['hard', 'progresses']);

// Gantt view constants
const WEEK_PX = 8;
const LABEL_COL_W = 200;
const ROW_H = 24;
const BAR_H = 18;
const BAR_PAD_TOP = 3;
const HEADER_H = 50;
const FOOTER_H = 70;

const STORAGE_KEY = 'opal-explorer-selection';
const VIEW_STORAGE_KEY = 'opal-explorer-view';
const CONFIDENCE_STORAGE_KEY = 'opal-explorer-confidence';

const state = {
  graph: null,
  nodesById: new Map(),
  edgesByFrom: new Map(),
  edgesByTo: new Map(),
  layerById: new Map(),
  laneOrder: [],

  // Architecture-view layout
  archPositions: new Map(),       // id -> {x, y, laneId, row, col}
  archCanvasSize: { w: 1200, h: 800 },
  laneRects: [],

  // Ladder-view layout
  ladderPositions: new Map(),     // id -> {x, y, ladderId, tier}
  ladderCanvasSize: { w: 1200, h: 600 },
  ladderRows: [],                 // [{ladderId, top, label, height}]
  ladderTierColumns: [],          // [{tier, x}]
  ladderNodeIds: new Set(),       // ids that appear in any ladder
  ladderTierByNode: new Map(),    // id -> {ladderId, tier, label}

  view: 'architecture',           // 'architecture' | 'ladder' | 'gantt'
  confidence: 'expected',         // 'low' | 'expected' | 'high' (Gantt only)

  // Last computed Gantt schedule
  gantt: {
    rowOrder: [],                 // ordered node ids included as bars
    start: new Map(),             // id -> start week
    end: new Map(),               // id -> end week
    duration: new Map(),          // id -> duration weeks (per current confidence)
    totalWeeks: 0,
    criticalPath: [],             // ids in order, foundation-first
    criticalSet: new Set()
  },

  selected: new Set(),
  hoveredId: null,
  filter: { layers: new Set(), categories: new Set(), search: '' },

  derived: {
    required: new Set(),
    unlocks: new Set(),
    softSuggestions: new Set(),
    requiredReason: new Map(),
    unlocksReadiness: new Map()
  },

  urlSyncTimer: null,
  transitioning: false
};

// ---------- Loading ----------

async function loadGraph() {
  const res = await fetch('opal_feature_graph.json');
  if (!res.ok) throw new Error('Failed to load graph');
  const graph = await res.json();
  state.graph = graph;

  for (const node of graph.nodes) state.nodesById.set(node.id, node);
  for (const layer of graph.layers) state.layerById.set(layer.id, layer);

  state.laneOrder = [...graph.layers].sort((a, b) => a.order - b.order).map(l => l.id);

  for (const e of graph.edges) {
    if (!state.edgesByFrom.has(e.from)) state.edgesByFrom.set(e.from, []);
    if (!state.edgesByTo.has(e.to)) state.edgesByTo.set(e.to, []);
    state.edgesByFrom.get(e.from).push(e);
    state.edgesByTo.get(e.to).push(e);
  }

  for (const ladder of graph.ladders || []) {
    for (const tier of ladder.tiers) {
      state.ladderNodeIds.add(tier.node);
      state.ladderTierByNode.set(tier.node, {
        ladderId: ladder.id,
        tier: tier.tier,
        label: tier.label
      });
    }
  }
}

// ---------- Layout: architecture ----------

function layoutArchitecture() {
  state.archPositions.clear();
  state.laneRects = [];

  const nodesByLane = new Map();
  for (const id of state.laneOrder) nodesByLane.set(id, []);
  for (const node of state.graph.nodes) {
    if (!nodesByLane.has(node.layer)) nodesByLane.set(node.layer, []);
    nodesByLane.get(node.layer).push(node);
  }

  let cursorY = CANVAS_PADDING;
  let maxRight = 0;

  for (const laneId of state.laneOrder) {
    const laneNodes = nodesByLane.get(laneId) || [];
    const rows = Math.max(1, Math.ceil(laneNodes.length / NODES_PER_ROW));
    const laneHeight = LANE_PADDING_Y * 2 + rows * NODE_HEIGHT + (rows - 1) * NODE_GAP_Y;

    state.laneRects.push({
      laneId,
      top: cursorY,
      height: laneHeight,
      bottom: cursorY + laneHeight,
      label: state.layerById.get(laneId)?.title ?? laneId
    });

    laneNodes.forEach((node, idx) => {
      const row = Math.floor(idx / NODES_PER_ROW);
      const col = idx % NODES_PER_ROW;
      const x = LANE_LABEL_W + CANVAS_PADDING + col * (NODE_WIDTH + NODE_GAP_X);
      const y = cursorY + LANE_PADDING_Y + row * (NODE_HEIGHT + NODE_GAP_Y);
      state.archPositions.set(node.id, { x, y, laneId, row, col });
      maxRight = Math.max(maxRight, x + NODE_WIDTH);
    });

    cursorY += laneHeight;
  }

  state.archCanvasSize = {
    w: maxRight + CANVAS_PADDING,
    h: cursorY + CANVAS_PADDING
  };
}

// ---------- Layout: ladder ----------

function layoutLadder() {
  state.ladderPositions.clear();
  state.ladderRows = [];
  state.ladderTierColumns = [];

  const ladders = state.graph.ladders || [];
  if (!ladders.length) return;

  let minTier = Infinity, maxTier = -Infinity;
  for (const ladder of ladders) {
    for (const t of ladder.tiers) {
      if (t.tier < minTier) minTier = t.tier;
      if (t.tier > maxTier) maxTier = t.tier;
    }
  }

  const tiersTop = CANVAS_PADDING;
  const headerH = LADDER_HEADER_H;
  const laddersTop = tiersTop + headerH + 8;

  // Tier column headers
  for (let t = minTier; t <= maxTier; t++) {
    const x = LADDER_LABEL_W + CANVAS_PADDING + (t - minTier) * (TIER_NODE_WIDTH + TIER_GAP_X);
    state.ladderTierColumns.push({ tier: t, x, label: `Tier ${t}` });
  }

  let maxRight = 0;
  ladders.forEach((ladder, idx) => {
    const top = laddersTop + idx * (TIER_NODE_HEIGHT + LADDER_GAP_Y);
    state.ladderRows.push({
      ladderId: ladder.id,
      title: ladder.title,
      description: ladder.description,
      top,
      height: TIER_NODE_HEIGHT
    });
    for (const tier of ladder.tiers) {
      const x = LADDER_LABEL_W + CANVAS_PADDING + (tier.tier - minTier) * (TIER_NODE_WIDTH + TIER_GAP_X);
      const y = top;
      state.ladderPositions.set(tier.node, {
        x, y,
        ladderId: ladder.id,
        tier: tier.tier,
        label: tier.label
      });
      maxRight = Math.max(maxRight, x + TIER_NODE_WIDTH);
    }
  });

  state.ladderCanvasSize = {
    w: maxRight + CANVAS_PADDING,
    h: laddersTop + ladders.length * (TIER_NODE_HEIGHT + LADDER_GAP_Y) + CANVAS_PADDING
  };
}

// ---------- View helpers ----------

function currentPositionFor(id) {
  if (state.view === 'ladder') {
    const lp = state.ladderPositions.get(id);
    if (lp) return { ...lp, w: TIER_NODE_WIDTH, h: TIER_NODE_HEIGHT };
    return null;
  }
  const ap = state.archPositions.get(id);
  if (ap) return { ...ap, w: NODE_WIDTH, h: NODE_HEIGHT };
  return null;
}

function nodeAnchorsAt(p) {
  return {
    top:    { x: p.x + p.w / 2, y: p.y },
    bottom: { x: p.x + p.w / 2, y: p.y + p.h },
    left:   { x: p.x, y: p.y + p.h / 2 },
    right:  { x: p.x + p.w, y: p.y + p.h / 2 }
  };
}

function edgePathArchitecture(edge) {
  const fromP = state.archPositions.get(edge.from);
  const toP = state.archPositions.get(edge.to);
  if (!fromP || !toP) return '';
  const fromA = nodeAnchorsAt({ ...fromP, w: NODE_WIDTH, h: NODE_HEIGHT });
  const toA = nodeAnchorsAt({ ...toP, w: NODE_WIDTH, h: NODE_HEIGHT });

  if (fromP.laneId === toP.laneId) {
    const goingRight = toP.x > fromP.x;
    const a = goingRight ? fromA.right : fromA.left;
    const b = goingRight ? toA.left : toA.right;
    const midY = Math.max(a.y, b.y) + 18;
    const c1x = a.x + (b.x - a.x) * 0.25;
    const c2x = a.x + (b.x - a.x) * 0.75;
    return `M ${a.x} ${a.y} C ${c1x} ${midY}, ${c2x} ${midY}, ${b.x} ${b.y}`;
  }

  const fromIsAbove = fromP.y < toP.y;
  const a = fromIsAbove ? fromA.bottom : fromA.top;
  const b = fromIsAbove ? toA.top : toA.bottom;
  const offset = 40;
  const c1y = fromIsAbove ? a.y + offset : a.y - offset;
  const c2y = fromIsAbove ? b.y - offset : b.y + offset;
  return `M ${a.x} ${a.y} C ${a.x} ${c1y}, ${b.x} ${c2y}, ${b.x} ${b.y}`;
}

function edgePathLadder(fromId, toId) {
  const fromP = state.ladderPositions.get(fromId);
  const toP = state.ladderPositions.get(toId);
  if (!fromP || !toP) return '';
  const fromA = nodeAnchorsAt({ ...fromP, w: TIER_NODE_WIDTH, h: TIER_NODE_HEIGHT });
  const toA = nodeAnchorsAt({ ...toP, w: TIER_NODE_WIDTH, h: TIER_NODE_HEIGHT });
  // Simple straight horizontal arrow Tier N → N+1 within a ladder row
  return `M ${fromA.right.x} ${fromA.right.y} L ${toA.left.x} ${toA.left.y}`;
}

// ---------- Recompute ----------

function bfsRequired(startId, visit) {
  const seen = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    for (const e of state.edgesByFrom.get(id) || []) {
      if (!REQUIRED_TYPES.has(e.type)) continue;
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      visit(e, id);
      queue.push(e.to);
    }
  }
}

function recompute() {
  const required = new Set();
  const requiredReason = new Map();

  for (const id of state.selected) {
    bfsRequired(id, (edge) => {
      if (!required.has(edge.to) && !state.selected.has(edge.to)) {
        required.add(edge.to);
        requiredReason.set(edge.to, id);
      }
    });
  }

  const inScope = new Set([...state.selected, ...required]);

  const unlocks = new Set();
  for (const id of inScope) {
    for (const e of state.edgesByTo.get(id) || []) {
      if (!inScope.has(e.from)) unlocks.add(e.from);
    }
  }

  const unlocksReadiness = new Map();
  for (const id of unlocks) {
    let inScopeDeps = 0;
    let totalDeps = 0;
    for (const e of state.edgesByFrom.get(id) || []) {
      if (!REQUIRED_TYPES.has(e.type)) continue;
      totalDeps++;
      if (inScope.has(e.to)) inScopeDeps++;
    }
    unlocksReadiness.set(id, { inScope: inScopeDeps, total: totalDeps });
  }

  const softSuggestions = new Set();
  for (const id of inScope) {
    for (const e of state.edgesByFrom.get(id) || []) {
      if (e.type !== 'soft') continue;
      if (!inScope.has(e.to)) softSuggestions.add(e.to);
    }
  }

  state.derived = { required, unlocks, softSuggestions, requiredReason, unlocksReadiness };
}

// ---------- State helpers ----------

function nodeStateFor(id) {
  if (state.selected.has(id)) return 'selected';
  if (state.derived.required.has(id)) return 'required';
  if (state.derived.unlocks.has(id)) return 'unlocks';
  return 'available';
}

function isFiltered(node) {
  const f = state.filter;
  if (f.layers.size && !f.layers.has(node.layer)) return true;
  if (f.categories.size && !f.categories.has(node.category)) return true;
  if (f.search) {
    const hay = (node.title + ' ' + node.subtitle + ' ' + node.description).toLowerCase();
    if (!hay.includes(f.search.toLowerCase())) return true;
  }
  return false;
}
function isSearchHit(node) {
  const q = state.filter.search?.trim().toLowerCase();
  if (!q) return false;
  const hay = (node.title + ' ' + node.subtitle + ' ' + node.description).toLowerCase();
  return hay.includes(q);
}

// ---------- Render: SVG ----------

function svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) {
    if (attrs[k] === null || attrs[k] === undefined) continue;
    el.setAttribute(k, attrs[k]);
  }
  for (const child of children) if (child) el.appendChild(child);
  return el;
}

// ---------- Gantt scheduling ----------

function durationFor(node) {
  const eff = node.effort || {};
  const c = state.confidence;
  if (c === 'low') return eff.devWeeksLow ?? 0;
  if (c === 'high') return eff.devWeeksHigh ?? 0;
  return eff.devWeeksExpected ?? 0;
}

function computeSchedule() {
  const inScope = new Set([...state.selected, ...state.derived.required]);

  // Exclude external nodes from the chart (per spec §3).
  const scheduled = [];
  for (const id of inScope) {
    const node = state.nodesById.get(id);
    if (!node) continue;
    if (node.layer === 'external') continue;
    scheduled.push(id);
  }

  // Build deps-of restricted to in-scope schedulable nodes.
  const depsOf = new Map();
  for (const id of scheduled) depsOf.set(id, new Set());
  for (const e of state.graph.edges) {
    if (!REQUIRED_TYPES.has(e.type)) continue;
    if (!depsOf.has(e.from) || !depsOf.has(e.to)) continue;
    depsOf.get(e.from).add(e.to);
  }

  const start = new Map();
  const end = new Map();
  const duration = new Map();
  const visiting = new Set();

  function compute(id) {
    if (end.has(id)) return;
    if (visiting.has(id)) return; // safety against unexpected cycles
    visiting.add(id);
    const deps = [...depsOf.get(id)];
    for (const d of deps) compute(d);
    const s = deps.length ? Math.max(...deps.map(d => end.get(d) ?? 0)) : 0;
    const dur = durationFor(state.nodesById.get(id));
    start.set(id, s);
    duration.set(id, dur);
    end.set(id, s + dur);
    visiting.delete(id);
  }
  for (const id of scheduled) compute(id);

  const totalWeeks = end.size ? Math.max(...end.values()) : 0;

  // Critical path: trace back from the latest-ending node, picking the dep with the latest end.
  const criticalPath = [];
  if (end.size) {
    let cur = scheduled.reduce((best, id) => (end.get(id) > end.get(best) ? id : best), scheduled[0]);
    criticalPath.unshift(cur);
    while (true) {
      const deps = [...depsOf.get(cur)];
      if (!deps.length) break;
      cur = deps.reduce((best, d) => (end.get(d) > end.get(best) ? d : best), deps[0]);
      criticalPath.unshift(cur);
    }
  }
  const criticalSet = new Set(criticalPath);

  // Row order: layer order, then ascending start week.
  const layerOrder = new Map();
  state.laneOrder.forEach((id, idx) => layerOrder.set(id, idx));
  const rowOrder = [...scheduled].sort((a, b) => {
    const la = layerOrder.get(state.nodesById.get(a).layer) ?? 99;
    const lb = layerOrder.get(state.nodesById.get(b).layer) ?? 99;
    if (la !== lb) return la - lb;
    const sa = start.get(a) ?? 0;
    const sb = start.get(b) ?? 0;
    if (sa !== sb) return sa - sb;
    return state.nodesById.get(a).title.localeCompare(state.nodesById.get(b).title);
  });

  state.gantt = { rowOrder, start, end, duration, totalWeeks, criticalPath, criticalSet };
}

function ganttCanvasSize() {
  const total = Math.max(state.gantt.totalWeeks, 1);
  const w = LABEL_COL_W + total * WEEK_PX + 24;
  const h = HEADER_H + state.gantt.rowOrder.length * ROW_H + FOOTER_H;
  return { w: Math.max(w, 720), h: Math.max(h, 320) };
}

function renderGantt(canvas) {
  computeSchedule();
  const size = ganttCanvasSize();
  canvas.setAttribute('width', size.w);
  canvas.setAttribute('height', size.h);
  canvas.setAttribute('viewBox', `0 0 ${size.w} ${size.h}`);
  canvas.innerHTML = '';

  const total = state.gantt.totalWeeks;
  const chartLeft = LABEL_COL_W;
  const chartRight = LABEL_COL_W + total * WEEK_PX;
  const chartTop = HEADER_H;
  const chartBottom = HEADER_H + state.gantt.rowOrder.length * ROW_H;

  const root = svg('g', { 'data-layer': 'gantt' });

  // Empty state
  if (!state.gantt.rowOrder.length) {
    const t = svg('text', { class: 'gantt-empty', x: 32, y: 80 });
    t.textContent = 'Nothing in scope yet — click a module to start.';
    root.appendChild(t);
    canvas.appendChild(root);
    return;
  }

  // Phase boundaries: first non-foundation start week, first policy/post-sale start week.
  let firstNonFoundation = null;
  let firstPolicy = null;
  for (const id of state.gantt.rowOrder) {
    const node = state.nodesById.get(id);
    const s = state.gantt.start.get(id);
    if (firstNonFoundation === null && node.layer !== 'foundation' && node.layer !== 'external') {
      firstNonFoundation = s;
    }
    if (firstPolicy === null && (node.layer === 'policy' || node.layer === 'reporting' || node.layer === 'agency' || node.layer === 'network')) {
      firstPolicy = s;
    }
  }

  // --- Header: phase labels + week numbers ---
  const header = svg('g', { 'data-layer': 'gantt-header' });
  const phases = [];
  if (firstNonFoundation !== null) {
    phases.push({ label: 'Foundation', from: 0, to: firstNonFoundation });
    if (firstPolicy !== null && firstPolicy > firstNonFoundation) {
      phases.push({ label: 'Build',  from: firstNonFoundation, to: firstPolicy });
      phases.push({ label: 'Polish', from: firstPolicy, to: total });
    } else {
      phases.push({ label: 'Build', from: firstNonFoundation, to: total });
    }
  } else {
    phases.push({ label: 'Schedule', from: 0, to: total });
  }
  for (const p of phases) {
    const x1 = chartLeft + p.from * WEEK_PX;
    const x2 = chartLeft + p.to * WEEK_PX;
    const t = svg('text', {
      class: 'gantt-phase-label',
      x: (x1 + x2) / 2,
      y: 18,
      'text-anchor': 'middle'
    });
    t.textContent = p.label;
    header.appendChild(t);
  }
  // Week numbers every 8 weeks
  for (let w = 0; w <= total; w += 8) {
    const x = chartLeft + w * WEEK_PX;
    const t = svg('text', {
      class: 'gantt-week-label',
      x, y: 38,
      'text-anchor': 'middle'
    });
    t.textContent = `wk ${w}`;
    header.appendChild(t);
  }
  // Hairline
  header.appendChild(svg('line', {
    class: 'gantt-hairline',
    x1: 0, x2: size.w, y1: HEADER_H - 0.5, y2: HEADER_H - 0.5
  }));
  root.appendChild(header);

  // --- Grid lines ---
  const grid = svg('g', { 'data-layer': 'gantt-grid' });
  for (let w = 0; w <= total; w += 8) {
    const x = chartLeft + w * WEEK_PX;
    grid.appendChild(svg('line', {
      class: 'gantt-grid-line',
      x1: x, x2: x, y1: chartTop, y2: chartBottom
    }));
  }
  // Phase boundary markers (dashed)
  for (const p of phases.slice(1)) {
    const x = chartLeft + p.from * WEEK_PX;
    grid.appendChild(svg('line', {
      class: 'gantt-phase-marker',
      x1: x, x2: x, y1: chartTop, y2: chartBottom
    }));
  }
  root.appendChild(grid);

  // --- Bars ---
  const bars = svg('g', { 'data-layer': 'gantt-bars' });
  state.gantt.rowOrder.forEach((id, rowIdx) => {
    const node = state.nodesById.get(id);
    const s = state.gantt.start.get(id) ?? 0;
    const dur = Math.max(state.gantt.duration.get(id) ?? 0, 0.25); // min visible
    const isCritical = state.gantt.criticalSet.has(id);
    const isSelected = state.selected.has(id);
    const isRequired = state.derived.required.has(id) && !isSelected;

    const y = chartTop + rowIdx * ROW_H;
    const barX = chartLeft + s * WEEK_PX;
    const barW = Math.max(dur * WEEK_PX, 4);

    // Row label (clickable)
    const rowG = svg('g', {
      class: 'gantt-row',
      'data-id': id,
      'data-critical': isCritical ? 'true' : 'false',
      'data-required': isRequired ? 'true' : 'false',
      'data-selected': isSelected ? 'true' : 'false'
    });
    rowG.appendChild(svg('rect', {
      class: 'gantt-row-hit',
      x: 0, y, width: size.w, height: ROW_H
    }));
    const labelEl = svg('text', {
      class: 'gantt-row-label',
      x: 12, y: y + ROW_H / 2 + 4
    });
    labelEl.textContent = truncate(node.title, 24);
    rowG.appendChild(labelEl);

    // Bar
    rowG.appendChild(svg('rect', {
      class: 'gantt-bar',
      'data-layer-id': node.layer,
      x: barX, y: y + BAR_PAD_TOP,
      width: barW, height: BAR_H,
      rx: 3, ry: 3
    }));

    // Click + hover
    rowG.addEventListener('click', () => onNodeClick(id));
    rowG.addEventListener('mouseenter', (e) => onNodeHover(id, e));
    rowG.addEventListener('mouseleave', () => onNodeLeave(id));
    rowG.addEventListener('mousemove', (e) => moveTooltip(e));

    bars.appendChild(rowG);
  });
  root.appendChild(bars);

  // --- Footer ---
  const footer = svg('g', { 'data-layer': 'gantt-footer' });
  const footerY = chartBottom + 18;
  const cpLabel = svg('text', { class: 'gantt-cp-label', x: 12, y: footerY });
  const cpTitles = state.gantt.criticalPath
    .map(id => state.nodesById.get(id)?.title ?? id)
    .join(' → ');
  cpLabel.textContent = `★ Critical path: ${state.gantt.totalWeeks.toFixed(1)} wk — ${cpTitles}`;
  footer.appendChild(cpLabel);

  // Totals readout
  const inScopeIds = new Set([...state.selected, ...state.derived.required]);
  let weight = 0;
  let cost = 0;
  let externalCost = 0;
  let nonExtCount = 0;
  for (const id of state.gantt.rowOrder) {
    const eff = state.nodesById.get(id).effort || {};
    weight += eff.devWeeksExpected || 0;
    cost   += eff.costUsdExpected   || 0;
    externalCost += eff.externalCostsUsd || 0;
    nonExtCount++;
  }
  const totals = svg('text', {
    class: 'gantt-totals',
    x: size.w - 12, y: footerY,
    'text-anchor': 'end'
  });
  const costM = (cost + externalCost) / 1_000_000;
  totals.textContent = `≈ ${nonExtCount} modules · ${weight.toFixed(0)} dev-wk · ~$${costM.toFixed(2)}M`;
  footer.appendChild(totals);

  // Legend (layers actually present)
  const legendY = footerY + 22;
  const presentLayers = [];
  const seen = new Set();
  for (const id of state.gantt.rowOrder) {
    const layer = state.nodesById.get(id).layer;
    if (seen.has(layer)) continue;
    seen.add(layer);
    presentLayers.push(layer);
  }
  let legX = 12;
  for (const layerId of presentLayers) {
    const layer = state.layerById.get(layerId);
    const sw = svg('rect', {
      class: 'gantt-legend-swatch',
      'data-layer-id': layerId,
      x: legX, y: legendY - 9, width: 10, height: 10, rx: 2, ry: 2
    });
    footer.appendChild(sw);
    const t = svg('text', {
      class: 'gantt-legend-label',
      x: legX + 14, y: legendY
    });
    t.textContent = layer?.title ?? layerId;
    footer.appendChild(t);
    legX += 14 + (layer?.title?.length ?? layerId.length) * 6.2 + 14;
  }
  root.appendChild(footer);

  canvas.appendChild(root);
}

function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

// ---------- Render dispatcher ----------

function renderCanvas() {
  const canvas = document.getElementById('canvas');
  document.querySelector('.canvas-wrap').setAttribute('data-view', state.view);

  if (state.view === 'gantt') {
    renderGantt(canvas);
    return;
  }

  const size = state.view === 'ladder' ? state.ladderCanvasSize : state.archCanvasSize;
  canvas.setAttribute('width', size.w);
  canvas.setAttribute('height', size.h);
  canvas.setAttribute('viewBox', `0 0 ${size.w} ${size.h}`);
  canvas.innerHTML = '';

  if (state.view === 'architecture') {
    renderArchitectureBackground(canvas);
    renderArchitectureEdges(canvas);
    renderNodes(canvas, 'architecture');
  } else {
    renderLadderBackground(canvas);
    renderLadderEdges(canvas);
    renderNodes(canvas, 'ladder');
  }
}

function renderArchitectureBackground(canvas) {
  const laneGroup = svg('g', { 'data-layer': 'lanes' });
  state.laneRects.forEach((lane, idx) => {
    laneGroup.appendChild(svg('rect', {
      class: 'lane-bg' + (idx % 2 === 1 ? ' alt' : ''),
      x: 0, y: lane.top,
      width: state.archCanvasSize.w, height: lane.height
    }));
    const labelEl = svg('text', {
      class: 'lane-label',
      x: CANVAS_PADDING,
      y: lane.top + LANE_PADDING_Y + 4
    });
    labelEl.textContent = lane.label;
    laneGroup.appendChild(labelEl);
  });
  canvas.appendChild(laneGroup);
}

function renderArchitectureEdges(canvas) {
  const edgeGroup = svg('g', { 'data-layer': 'edges' });
  for (const e of state.graph.edges) {
    edgeGroup.appendChild(svg('path', {
      class: 'edge',
      d: edgePathArchitecture(e),
      'data-from': e.from,
      'data-to': e.to,
      'data-type': e.type
    }));
  }
  canvas.appendChild(edgeGroup);
}

function renderLadderBackground(canvas) {
  const bg = svg('g', { 'data-layer': 'ladder-bg' });

  // Tier column headers
  for (const col of state.ladderTierColumns) {
    const t = svg('text', {
      class: 'lane-label',
      x: col.x,
      y: CANVAS_PADDING + 14
    });
    t.textContent = col.label;
    bg.appendChild(t);
  }

  // Ladder row labels + alternating background
  state.ladderRows.forEach((row, idx) => {
    bg.appendChild(svg('rect', {
      class: 'lane-bg' + (idx % 2 === 1 ? ' alt' : ''),
      x: 0,
      y: row.top - LADDER_GAP_Y / 2,
      width: state.ladderCanvasSize.w,
      height: row.height + LADDER_GAP_Y
    }));
    const t = svg('text', {
      class: 'lane-label',
      x: CANVAS_PADDING,
      y: row.top + row.height / 2 + 4
    });
    t.textContent = row.title;
    bg.appendChild(t);
  });

  canvas.appendChild(bg);
}

function renderLadderEdges(canvas) {
  // Within each ladder row, draw arrows between consecutive tier nodes.
  const edgeGroup = svg('g', { 'data-layer': 'edges' });
  for (const ladder of state.graph.ladders || []) {
    const sorted = [...ladder.tiers].sort((a, b) => a.tier - b.tier);
    for (let i = 0; i < sorted.length - 1; i++) {
      const from = sorted[i].node;
      const to = sorted[i + 1].node;
      edgeGroup.appendChild(svg('path', {
        class: 'edge',
        d: edgePathLadder(from, to),
        'data-from': from,
        'data-to': to,
        'data-type': 'progresses'
      }));
    }
  }
  canvas.appendChild(edgeGroup);
}

function renderNodes(canvas, view) {
  const nodeGroup = svg('g', { 'data-layer': 'nodes' });
  for (const node of state.graph.nodes) {
    const inLadder = state.ladderNodeIds.has(node.id);
    const visibleInView = view === 'architecture' || inLadder;
    const p = view === 'ladder'
      ? state.ladderPositions.get(node.id)
      : state.archPositions.get(node.id);
    if (!p) continue;

    const w = view === 'ladder' ? TIER_NODE_WIDTH : NODE_WIDTH;
    const h = view === 'ladder' ? TIER_NODE_HEIGHT : NODE_HEIGHT;

    const g = svg('g', {
      class: 'node',
      'data-id': node.id,
      'data-layer-id': node.layer,
      'data-category': node.category,
      'data-in-ladder': inLadder ? 'true' : 'false',
      style: `transform: translate(${p.x}px, ${p.y}px); opacity: ${visibleInView ? 1 : 0};`
    });
    g.appendChild(svg('rect', {
      class: 'node-rect',
      x: 0, y: 0,
      width: w, height: h,
      rx: 6, ry: 6
    }));

    if (view === 'ladder') {
      const lt = state.ladderTierByNode.get(node.id);
      const titleEl = svg('text', { class: 'node-title', x: 8, y: 18 });
      titleEl.textContent = node.title;
      g.appendChild(titleEl);
      const subEl = svg('text', { class: 'node-sub', x: 8, y: 34 });
      subEl.textContent = lt ? lt.label : node.subtitle;
      g.appendChild(subEl);
    } else {
      const titleEl = svg('text', { class: 'node-title', x: 10, y: 22 });
      titleEl.textContent = node.title;
      g.appendChild(titleEl);
      const subEl = svg('text', { class: 'node-sub', x: 10, y: 40 });
      subEl.textContent = node.subtitle;
      g.appendChild(subEl);
    }

    g.addEventListener('click', () => onNodeClick(node.id));
    g.addEventListener('mouseenter', (e) => onNodeHover(node.id, e));
    g.addEventListener('mouseleave', () => onNodeLeave(node.id));
    g.addEventListener('mousemove', (e) => moveTooltip(e));

    nodeGroup.appendChild(g);
  }
  canvas.appendChild(nodeGroup);
}

function applyVisualState() {
  if (state.view === 'gantt') {
    applyGanttHoverState();
    return;
  }
  // Node states
  document.querySelectorAll('#canvas .node').forEach(g => {
    const id = g.getAttribute('data-id');
    const node = state.nodesById.get(id);
    let s = nodeStateFor(id);
    if (state.filter.layers.size || state.filter.categories.size || state.filter.search) {
      if (isFiltered(node) && s === 'available') s = 'dimmed';
    }
    g.setAttribute('data-state', s);
    g.setAttribute('data-search-hit', isSearchHit(node) ? 'true' : 'false');
    g.setAttribute('data-hovered', state.hoveredId === id ? 'true' : 'false');
  });

  // Edge states
  const inScope = new Set([...state.selected, ...state.derived.required]);
  document.querySelectorAll('#canvas .edge').forEach(p => {
    const from = p.getAttribute('data-from');
    const to = p.getAttribute('data-to');
    const type = p.getAttribute('data-type');

    let edgeState = '';
    const fromInScope = inScope.has(from);
    const toInScope = inScope.has(to);

    if ((type === 'hard' || type === 'progresses') && fromInScope && toInScope) {
      if (state.selected.has(to)) {
        edgeState = 'feeds-selected';
      } else if (state.derived.required.has(to)) {
        edgeState = type === 'progresses' ? 'active-progresses' : 'active-required';
      }
    } else if (type === 'soft' && fromInScope && !toInScope) {
      edgeState = 'active-soft';
    }

    p.setAttribute('data-state', edgeState);

    if (state.hoveredId) {
      if (from === state.hoveredId) p.setAttribute('data-hover', 'dep');
      else if (to === state.hoveredId) p.setAttribute('data-hover', 'dependent');
      else p.removeAttribute('data-hover');
    } else {
      p.removeAttribute('data-hover');
    }
  });
}

function applyGanttHoverState() {
  const hovered = state.hoveredId;
  const upstream = new Set();
  if (hovered && state.gantt.rowOrder.includes(hovered)) {
    // Walk back through hard+progresses deps that are in scope.
    const deps = new Map();
    for (const id of state.gantt.rowOrder) deps.set(id, []);
    for (const e of state.graph.edges) {
      if (!REQUIRED_TYPES.has(e.type)) continue;
      if (!deps.has(e.from) || !deps.has(e.to)) continue;
      deps.get(e.from).push(e.to);
    }
    const queue = [hovered];
    upstream.add(hovered);
    while (queue.length) {
      const id = queue.shift();
      for (const d of deps.get(id) || []) {
        if (!upstream.has(d)) { upstream.add(d); queue.push(d); }
      }
    }
  }
  document.querySelectorAll('#canvas .gantt-row').forEach(g => {
    const id = g.getAttribute('data-id');
    g.setAttribute('data-hovered', hovered === id ? 'true' : 'false');
    g.setAttribute('data-upstream', (hovered && upstream.has(id)) ? 'true' : 'false');
  });
}

// ---------- View toggle ----------

function setView(nextView) {
  if (nextView === state.view) return;
  state.view = nextView;
  try { localStorage.setItem(VIEW_STORAGE_KEY, nextView); } catch {}

  document.querySelectorAll('#view-toggle .chip').forEach(c => {
    c.setAttribute('aria-pressed', String(c.dataset.view === nextView));
  });
  renderConfidenceToggle();

  renderCanvas();
  applyVisualState();
  renderDrawer();
}

// ---------- Render: drawer ----------

function nodeRow(node, opts = {}) {
  const row = document.createElement('div');
  row.className = 'node-row';
  row.setAttribute('data-id', node.id);

  const text = document.createElement('div');
  text.className = 'nr-text';
  const title = document.createElement('div');
  title.className = 'nr-title';
  title.textContent = node.title;
  const sub = document.createElement('div');
  sub.className = 'nr-sub';
  sub.textContent = node.subtitle;
  text.appendChild(title);
  text.appendChild(sub);
  row.appendChild(text);

  if (opts.removable) {
    const btn = document.createElement('button');
    btn.className = 'nr-action';
    btn.type = 'button';
    btn.textContent = '×';
    btn.title = 'Remove';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.selected.delete(node.id);
      onSelectionChanged();
    });
    row.appendChild(btn);
  }
  if (opts.add) {
    const btn = document.createElement('button');
    btn.className = 'nr-action';
    btn.type = 'button';
    btn.textContent = '+ add';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.selected.add(node.id);
      onSelectionChanged();
    });
    row.appendChild(btn);
  }
  if (opts.why) {
    const why = document.createElement('span');
    why.className = 'nr-why';
    const reasonId = state.derived.requiredReason.get(node.id);
    const reason = reasonId ? state.nodesById.get(reasonId) : null;
    why.textContent = reason ? `← ${reason.title}` : '';
    why.title = reason ? `Pulled in by: ${reason.title}` : '';
    row.appendChild(why);
  }

  row.addEventListener('mouseenter', () => {
    state.hoveredId = node.id;
    applyVisualState();
  });
  row.addEventListener('mouseleave', () => {
    state.hoveredId = null;
    applyVisualState();
  });

  return row;
}

function groupByLane(ids) {
  const byLane = new Map();
  for (const laneId of state.laneOrder) byLane.set(laneId, []);
  for (const id of ids) {
    const node = state.nodesById.get(id);
    if (!node) continue;
    if (!byLane.has(node.layer)) byLane.set(node.layer, []);
    byLane.get(node.layer).push(node);
  }
  return byLane;
}

function renderList(container, ids, opts = {}) {
  container.innerHTML = '';
  if (!ids.length) return;
  const byLane = groupByLane(ids);
  for (const [laneId, nodes] of byLane) {
    if (!nodes.length) continue;
    const divider = document.createElement('div');
    divider.className = 'lane-divider';
    divider.textContent = state.layerById.get(laneId)?.title ?? laneId;
    container.appendChild(divider);
    for (const node of nodes) container.appendChild(nodeRow(node, opts));
  }
}

let unlocksExpanded = false;

function renderDrawer() {
  const selectedIds = [...state.selected];
  const requiredIds = [...state.derived.required];
  const unlocksAll = [...state.derived.unlocks].sort((a, b) => {
    const ra = state.derived.unlocksReadiness.get(a) || { inScope: 0, total: 1 };
    const rb = state.derived.unlocksReadiness.get(b) || { inScope: 0, total: 1 };
    const da = (ra.total ? (ra.total - ra.inScope) : 99);
    const db = (rb.total ? (rb.total - rb.inScope) : 99);
    if (da !== db) return da - db;
    return state.nodesById.get(a).title.localeCompare(state.nodesById.get(b).title);
  });
  const unlocksToShow = unlocksExpanded ? unlocksAll : unlocksAll.slice(0, 6);
  const softIds = [...state.derived.softSuggestions];

  document.getElementById('count-selected').textContent = selectedIds.length;
  document.getElementById('count-required').textContent = requiredIds.length;
  document.getElementById('count-total').textContent = selectedIds.length + requiredIds.length;

  const empty = selectedIds.length === 0;
  document.getElementById('empty-state').hidden = !empty;

  const sectionSelected = document.getElementById('section-selected');
  sectionSelected.hidden = selectedIds.length === 0;
  if (!sectionSelected.hidden) {
    renderList(document.getElementById('list-selected'), selectedIds, { removable: true });
  }

  const sectionRequired = document.getElementById('section-required');
  sectionRequired.hidden = requiredIds.length === 0;
  if (!sectionRequired.hidden) {
    renderList(document.getElementById('list-required'), requiredIds, { why: true });
  }

  const sectionUnlocks = document.getElementById('section-unlocks');
  sectionUnlocks.hidden = unlocksAll.length === 0;
  if (!sectionUnlocks.hidden) {
    renderList(document.getElementById('list-unlocks'), unlocksToShow, { add: true });
    const showAll = document.getElementById('unlocks-show-all');
    showAll.hidden = unlocksAll.length <= 6;
    showAll.textContent = unlocksExpanded ? 'Show less' : `Show all (${unlocksAll.length})`;
  }

  const sectionSoft = document.getElementById('section-soft');
  sectionSoft.hidden = softIds.length === 0;
  if (!sectionSoft.hidden) {
    renderList(document.getElementById('list-soft'), softIds, { add: true });
  }

  const sectionStats = document.getElementById('section-stats');
  const total = selectedIds.length + requiredIds.length;
  sectionStats.hidden = total === 0;
  if (!sectionStats.hidden) {
    let weight = 0;
    let devWeeks = 0;
    let cost = 0;
    let externalCost = 0;
    for (const id of [...selectedIds, ...requiredIds]) {
      const n = state.nodesById.get(id);
      weight += n?.weight || 0;
      const eff = n?.effort;
      if (eff) {
        devWeeks += eff.devWeeksExpected || 0;
        cost += eff.costUsdExpected || 0;
        externalCost += eff.externalCostsUsd || 0;
      }
    }
    let bucket;
    if (weight <= 25) bucket = 'Lean · ~3 months';
    else if (weight <= 60) bucket = 'Standard · ~6 months';
    else if (weight <= 110) bucket = 'Large · ~12 months';
    else bucket = 'Platform · 18+ months';
    document.getElementById('stats-weight').textContent = weight;
    document.getElementById('stats-bucket').textContent = bucket;

    // Cost rollup (naive sum + critical path / calendar burn)
    computeSchedule();
    const cpWeeks = state.gantt.totalWeeks;
    const peakTeam = peakConcurrentTeam();
    const usdPerWk = state.graph.costModel?.usdPerDevWeek ?? 10000;
    const calendarBurn = cpWeeks * peakTeam * usdPerWk + externalCost;

    document.getElementById('stats-devweeks').textContent =
      devWeeks ? `${devWeeks.toFixed(0)} dev-wk` : '—';
    document.getElementById('stats-naive').textContent =
      cost ? `$${((cost + externalCost) / 1_000_000).toFixed(2)}M` : '—';
    document.getElementById('stats-burn').textContent =
      cpWeeks ? `~$${(calendarBurn / 1_000_000).toFixed(2)}M · ${cpWeeks.toFixed(0)}wk · peak ${peakTeam}` : '—';
  }
}

function peakConcurrentTeam() {
  if (!state.gantt.totalWeeks) return 0;
  const total = Math.ceil(state.gantt.totalWeeks);
  let peak = 0;
  for (let w = 0; w < total; w++) {
    let active = 0;
    for (const id of state.gantt.rowOrder) {
      const s = state.gantt.start.get(id) ?? 0;
      const e = state.gantt.end.get(id) ?? 0;
      if (s <= w && w < e) {
        active += state.nodesById.get(id).effort?.teamSize || 0;
      }
    }
    if (active > peak) peak = active;
  }
  return peak;
}

// ---------- Filters ----------

function renderFilterChips() {
  const layerEl = document.getElementById('filter-layers');
  layerEl.innerHTML = '';
  for (const laneId of state.laneOrder) {
    const layer = state.layerById.get(laneId);
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.setAttribute('aria-pressed', 'false');
    chip.dataset.layer = laneId;
    chip.textContent = layer.title;
    chip.addEventListener('click', () => {
      const pressed = chip.getAttribute('aria-pressed') === 'true';
      if (pressed) state.filter.layers.delete(laneId);
      else state.filter.layers.add(laneId);
      chip.setAttribute('aria-pressed', String(!pressed));
      applyVisualState();
    });
    layerEl.appendChild(chip);
  }

  const catEl = document.getElementById('filter-categories');
  catEl.innerHTML = '';
  for (const cat of ['core', 'feature', 'integration', 'ui']) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.setAttribute('aria-pressed', 'false');
    chip.dataset.category = cat;
    chip.textContent = cat;
    chip.addEventListener('click', () => {
      const pressed = chip.getAttribute('aria-pressed') === 'true';
      if (pressed) state.filter.categories.delete(cat);
      else state.filter.categories.add(cat);
      chip.setAttribute('aria-pressed', String(!pressed));
      applyVisualState();
    });
    catEl.appendChild(chip);
  }
}

function renderViewToggle() {
  const wrap = document.getElementById('view-toggle');
  wrap.innerHTML = '';
  for (const v of [
    { id: 'architecture', label: 'Architecture' },
    { id: 'ladder', label: 'Ladders' },
    { id: 'gantt', label: 'Gantt' }
  ]) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.type = 'button';
    btn.dataset.view = v.id;
    btn.textContent = v.label;
    btn.setAttribute('aria-pressed', String(state.view === v.id));
    btn.addEventListener('click', () => setView(v.id));
    wrap.appendChild(btn);
  }
}

function renderConfidenceToggle() {
  const wrap = document.getElementById('confidence-toggle');
  if (!wrap) return;
  wrap.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'inline-label';
  label.textContent = 'Confidence';
  wrap.appendChild(label);
  for (const v of [
    { id: 'low', label: 'Low' },
    { id: 'expected', label: 'Expected' },
    { id: 'high', label: 'High' }
  ]) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.type = 'button';
    btn.dataset.confidence = v.id;
    btn.textContent = v.label;
    btn.setAttribute('aria-pressed', String(state.confidence === v.id));
    btn.addEventListener('click', () => {
      if (state.confidence === v.id) return;
      state.confidence = v.id;
      try { localStorage.setItem(CONFIDENCE_STORAGE_KEY, v.id); } catch {}
      renderConfidenceToggle();
      if (state.view === 'gantt') {
        renderCanvas();
        applyVisualState();
        renderDrawer();
      }
    });
    wrap.appendChild(btn);
  }
  wrap.hidden = state.view !== 'gantt';
}

// ---------- Tooltip ----------

const tooltipEl = () => document.getElementById('tooltip');

function showTooltip(node, evt) {
  const tt = tooltipEl();
  tt.hidden = false;
  tt.innerHTML = '';
  const t = document.createElement('strong');
  t.textContent = node.title;
  const s = document.createElement('div');
  s.className = 'tt-sub';
  s.textContent = node.subtitle;
  const d = document.createElement('div');
  d.textContent = node.description;
  tt.appendChild(t);
  tt.appendChild(s);
  tt.appendChild(d);

  const eff = node.effort;
  if (eff && eff.devWeeksExpected > 0) {
    const e = document.createElement('div');
    e.className = 'tt-effort';
    const cost = eff.costUsdExpected ? `$${(eff.costUsdExpected / 1000).toFixed(0)}K` : '—';
    e.textContent = `${eff.devWeeksLow}–${eff.devWeeksExpected}–${eff.devWeeksHigh} dev-wk · ${eff.teamSize} eng · ${cost}`;
    tt.appendChild(e);
    if (eff.externalCostsUsd) {
      const x = document.createElement('div');
      x.className = 'tt-effort';
      x.textContent = `+ $${(eff.externalCostsUsd / 1000).toFixed(0)}K external`;
      tt.appendChild(x);
    }
    if (eff.notes) {
      const n = document.createElement('div');
      n.className = 'tt-notes';
      n.textContent = eff.notes;
      tt.appendChild(n);
    }
  }

  const m = document.createElement('div');
  m.className = 'tt-meta';
  const ladderInfo = state.ladderTierByNode.get(node.id);
  const parts = [
    state.layerById.get(node.layer)?.title ?? node.layer,
    node.category,
    `weight ${node.weight}`
  ];
  if (ladderInfo) {
    const ladder = state.graph.ladders.find(l => l.id === ladderInfo.ladderId);
    parts.push(`${ladder?.title ?? ladderInfo.ladderId} T${ladderInfo.tier}`);
  }
  if (state.gantt.criticalSet.has(node.id) && state.view === 'gantt') {
    parts.push('★ critical path');
  }
  m.textContent = parts.join(' · ');
  tt.appendChild(m);
  moveTooltip(evt);
}
function hideTooltip() { tooltipEl().hidden = true; }
function moveTooltip(evt) {
  const tt = tooltipEl();
  if (tt.hidden) return;
  const x = evt.clientX + 14;
  const y = evt.clientY + 14;
  const maxX = window.innerWidth - tt.offsetWidth - 8;
  const maxY = window.innerHeight - tt.offsetHeight - 8;
  tt.style.left = Math.min(x, maxX) + 'px';
  tt.style.top = Math.min(y, maxY) + 'px';
}

// ---------- Toast ----------

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

// ---------- Interactions ----------

function onNodeClick(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  onSelectionChanged();
}

function onNodeHover(id, evt) {
  state.hoveredId = id;
  applyVisualState();
  const node = state.nodesById.get(id);
  if (node) showTooltip(node, evt);
}
function onNodeLeave(id) {
  if (state.hoveredId === id) state.hoveredId = null;
  applyVisualState();
  hideTooltip();
}

function onSelectionChanged() {
  unlocksExpanded = false;
  recompute();
  computeSchedule();
  if (state.view === 'gantt') renderCanvas();
  applyVisualState();
  renderDrawer();
  syncUrl();
  syncStorage();
}

// ---------- URL + storage ----------

function readUrl() {
  const hash = (location.hash || '').replace(/^#/, '');
  if (!hash) return null;
  return hash.split(',').map(s => s.trim()).filter(Boolean);
}

function syncUrl() {
  clearTimeout(state.urlSyncTimer);
  state.urlSyncTimer = setTimeout(() => {
    const ids = [...state.selected];
    const hash = ids.length ? '#' + ids.join(',') : '';
    history.replaceState(null, '', location.pathname + location.search + hash);
  }, 200);
}

function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function syncStorage() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.selected])); }
  catch {}
}

// ---------- Presets ----------

function renderPresetPicker() {
  const sel = document.getElementById('preset-select');
  sel.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose…';
  sel.appendChild(placeholder);
  for (const p of state.graph.presets || []) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.title;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    loadPreset(sel.value);
    sel.value = '';
  });
}

function loadPreset(id) {
  const preset = state.graph.presets.find(p => p.id === id);
  if (!preset) return;

  if (state.selected.size > 0 && !confirm('Replace your current selection with this preset?')) return;

  let ids = preset.selected;
  if (id === 'industry-platform' && (!ids || ids.length === 0)) {
    ids = state.graph.nodes.map(n => n.id);
  }
  state.selected = new Set(ids);
  onSelectionChanged();
  toast(`Loaded: ${preset.title}`);
}

// ---------- Actions ----------

function exportArtifact() {
  if (state.view === 'gantt') exportGanttCsv();
  else exportJson();
}

function exportJson() {
  const requiredIds = [...state.derived.required];
  const selectedIds = [...state.selected];
  let weight = 0;
  let cost = 0;
  let externalCost = 0;
  for (const id of [...selectedIds, ...requiredIds]) {
    const n = state.nodesById.get(id);
    weight += n?.weight || 0;
    const eff = n?.effort;
    if (eff) {
      cost += eff.costUsdExpected || 0;
      externalCost += eff.externalCostsUsd || 0;
    }
  }
  const payload = {
    timestamp: new Date().toISOString(),
    selected: selectedIds,
    required: requiredIds,
    soft_suggestions: [...state.derived.softSuggestions],
    total_weight: weight,
    total_cost_usd: cost,
    external_costs_usd: externalCost,
    node_count: selectedIds.length + requiredIds.length
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `opal-scope-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportGanttCsv() {
  // Make sure schedule is fresh
  computeSchedule();

  const cols = ['id', 'title', 'layer', 'start_week', 'end_week', 'duration_weeks',
                'team_size', 'cost_usd', 'on_critical_path', 'notes'];
  const rows = [cols.join(',')];
  for (const id of state.gantt.rowOrder) {
    const node = state.nodesById.get(id);
    const eff = node.effort || {};
    rows.push([
      csvEscape(id),
      csvEscape(node.title),
      csvEscape(node.layer),
      csvEscape((state.gantt.start.get(id) ?? 0).toFixed(1)),
      csvEscape((state.gantt.end.get(id) ?? 0).toFixed(1)),
      csvEscape((state.gantt.duration.get(id) ?? 0).toFixed(1)),
      csvEscape(eff.teamSize ?? ''),
      csvEscape(eff.costUsdExpected ?? ''),
      csvEscape(state.gantt.criticalSet.has(id) ? 'true' : 'false'),
      csvEscape(eff.notes ?? '')
    ].join(','));
  }
  const blob = new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `opal-gantt-${date}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function copyShareLink() {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    toast('Copy failed');
  }
}

function resetSelection() {
  if (state.selected.size === 0) return;
  state.selected.clear();
  onSelectionChanged();
}

// ---------- Wire-up ----------

function wire() {
  document.getElementById('reset-btn').addEventListener('click', resetSelection);
  document.getElementById('export-btn').addEventListener('click', exportArtifact);
  document.getElementById('share-btn').addEventListener('click', copyShareLink);
  document.getElementById('empty-load-mvp').addEventListener('click', () => loadPreset('lean-mvp'));
  document.getElementById('unlocks-show-all').addEventListener('click', () => {
    unlocksExpanded = !unlocksExpanded;
    renderDrawer();
  });
  document.getElementById('toggle-drawer').addEventListener('click', () => {
    document.getElementById('drawer').classList.toggle('open');
  });

  const search = document.getElementById('search');
  search.addEventListener('input', () => {
    state.filter.search = search.value;
    applyVisualState();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.selected.size) resetSelection();
      else if (search.value) { search.value = ''; state.filter.search = ''; applyVisualState(); }
    }
  });

  window.addEventListener('hashchange', () => {
    const ids = readUrl();
    if (!ids) return;
    state.selected = new Set(ids.filter(id => state.nodesById.has(id)));
    recompute();
    applyVisualState();
    renderDrawer();
  });
}

// ---------- Boot ----------

async function boot() {
  try {
    await loadGraph();
  } catch (err) {
    console.error(err);
    document.body.innerHTML = `<pre style="padding:24px;color:#c00">Failed to load graph: ${err.message}</pre>`;
    return;
  }

  layoutArchitecture();
  layoutLadder();

  const fromUrl = readUrl();
  const fromStorage = readStorage();
  if (fromUrl && fromUrl.length) {
    state.selected = new Set(fromUrl.filter(id => state.nodesById.has(id)));
  } else if (fromStorage && Array.isArray(fromStorage)) {
    state.selected = new Set(fromStorage.filter(id => state.nodesById.has(id)));
  }

  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    if (v === 'architecture' || v === 'ladder' || v === 'gantt') state.view = v;
  } catch {}

  try {
    const c = localStorage.getItem(CONFIDENCE_STORAGE_KEY);
    if (c === 'low' || c === 'expected' || c === 'high') state.confidence = c;
  } catch {}

  renderFilterChips();
  renderViewToggle();
  renderConfidenceToggle();
  renderPresetPicker();
  recompute();
  computeSchedule(); // so drawer stats can read state.gantt at first render
  renderCanvas();
  applyVisualState();
  renderDrawer();
  wire();
}

document.addEventListener('DOMContentLoaded', boot);
