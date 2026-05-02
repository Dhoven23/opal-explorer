// Opal Feature Explorer — vanilla DOM + SVG.

const SVG_NS = 'http://www.w3.org/2000/svg';

const NODE_WIDTH = 168;
const NODE_HEIGHT = 60;
const NODE_GAP_X = 16;
const NODE_GAP_Y = 28;
const LANE_PADDING_Y = 32;
const LANE_LABEL_W = 120;
const CANVAS_PADDING = 32;
const NODES_PER_ROW = 6;

const STORAGE_KEY = 'opal-explorer-selection';

const state = {
  graph: null,
  nodesById: new Map(),
  edgesByFrom: new Map(),
  edgesByTo: new Map(),
  layerById: new Map(),
  laneOrder: [],
  nodePositions: new Map(),     // id -> {x, y, laneId, row, col}
  laneRects: [],                // [{laneId, top, bottom, height, label}]
  canvasSize: { w: 1200, h: 800 },

  selected: new Set(),
  hoveredId: null,
  filter: { layers: new Set(), categories: new Set(), search: '' },

  derived: {
    required: new Set(),
    unlocks: new Set(),
    softSuggestions: new Set(),
    requiredReason: new Map(),  // requiredId -> selectedId (one path)
    unlocksReadiness: new Map() // unlockId -> count of in-scope deps
  },

  urlSyncTimer: null
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
}

// ---------- Layout ----------

function layout() {
  state.nodePositions.clear();
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
      state.nodePositions.set(node.id, { x, y, laneId, row, col });
      maxRight = Math.max(maxRight, x + NODE_WIDTH);
    });

    cursorY += laneHeight;
  }

  state.canvasSize = {
    w: maxRight + CANVAS_PADDING,
    h: cursorY + CANVAS_PADDING
  };
}

// ---------- Recompute ----------

function bfsHard(startId, visit) {
  const seen = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    for (const e of state.edgesByFrom.get(id) || []) {
      if (e.type !== 'hard') continue;
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
    bfsHard(id, (edge) => {
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

  // Readiness: how many of an unlock's hard deps are already in scope
  const unlocksReadiness = new Map();
  for (const id of unlocks) {
    let inScopeDeps = 0;
    let totalDeps = 0;
    for (const e of state.edgesByFrom.get(id) || []) {
      if (e.type !== 'hard') continue;
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

function nodeAnchors(id) {
  const p = state.nodePositions.get(id);
  if (!p) return null;
  return {
    top:    { x: p.x + NODE_WIDTH / 2, y: p.y },
    bottom: { x: p.x + NODE_WIDTH / 2, y: p.y + NODE_HEIGHT },
    left:   { x: p.x, y: p.y + NODE_HEIGHT / 2 },
    right:  { x: p.x + NODE_WIDTH, y: p.y + NODE_HEIGHT / 2 }
  };
}

function edgePath(edge) {
  const fromP = state.nodePositions.get(edge.from);
  const toP = state.nodePositions.get(edge.to);
  if (!fromP || !toP) return '';

  const fromA = nodeAnchors(edge.from);
  const toA = nodeAnchors(edge.to);
  const sameLane = fromP.laneId === toP.laneId;

  if (sameLane) {
    // Side-to-side with a downward dip
    const goingRight = toP.x > fromP.x;
    const a = goingRight ? fromA.right : fromA.left;
    const b = goingRight ? toA.left : toA.right;
    const midY = Math.max(a.y, b.y) + 18;
    const c1x = a.x + (b.x - a.x) * 0.25;
    const c2x = a.x + (b.x - a.x) * 0.75;
    return `M ${a.x} ${a.y} C ${c1x} ${midY}, ${c2x} ${midY}, ${b.x} ${b.y}`;
  }

  // Cross-lane: from goes from its bottom anchor, to receives at its top anchor.
  // (Edge direction in spec: from → to; visual goes downward toward dependency.)
  // But since lanes are stacked top→bottom in declaration order and external is at top,
  // dependencies (foundation) are below dependents (workflow) in earlier-order lanes...
  // Actually per spec: from depends on to. We render from->to with vertical control.
  const fromIsAbove = fromP.y < toP.y;
  const a = fromIsAbove ? fromA.bottom : fromA.top;
  const b = fromIsAbove ? toA.top : toA.bottom;
  const offset = 40;
  const c1y = fromIsAbove ? a.y + offset : a.y - offset;
  const c2y = fromIsAbove ? b.y - offset : b.y + offset;
  return `M ${a.x} ${a.y} C ${a.x} ${c1y}, ${b.x} ${c2y}, ${b.x} ${b.y}`;
}

function renderCanvas() {
  const canvas = document.getElementById('canvas');
  canvas.setAttribute('width', state.canvasSize.w);
  canvas.setAttribute('height', state.canvasSize.h);
  canvas.setAttribute('viewBox', `0 0 ${state.canvasSize.w} ${state.canvasSize.h}`);
  canvas.innerHTML = '';

  // Lane backgrounds + labels
  const laneGroup = svg('g', { 'data-layer': 'lanes' });
  state.laneRects.forEach((lane, idx) => {
    laneGroup.appendChild(svg('rect', {
      class: 'lane-bg' + (idx % 2 === 1 ? ' alt' : ''),
      x: 0, y: lane.top,
      width: state.canvasSize.w, height: lane.height
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

  // Edges (rendered before nodes so nodes sit on top)
  const edgeGroup = svg('g', { 'data-layer': 'edges' });
  for (const e of state.graph.edges) {
    const path = svg('path', {
      class: 'edge',
      d: edgePath(e),
      'data-from': e.from,
      'data-to': e.to,
      'data-type': e.type,
      'data-soft': e.type === 'soft' ? 'true' : 'false'
    });
    edgeGroup.appendChild(path);
  }
  canvas.appendChild(edgeGroup);

  // Nodes
  const nodeGroup = svg('g', { 'data-layer': 'nodes' });
  for (const node of state.graph.nodes) {
    const p = state.nodePositions.get(node.id);
    if (!p) continue;
    const g = svg('g', {
      class: 'node',
      'data-id': node.id,
      'data-layer-id': node.layer,
      'data-category': node.category,
      transform: `translate(${p.x}, ${p.y})`
    });
    g.appendChild(svg('rect', {
      class: 'node-rect',
      x: 0, y: 0,
      width: NODE_WIDTH, height: NODE_HEIGHT,
      rx: 6, ry: 6
    }));
    const titleEl = svg('text', { class: 'node-title', x: 10, y: 22 });
    titleEl.textContent = node.title;
    g.appendChild(titleEl);
    const subEl = svg('text', { class: 'node-sub', x: 10, y: 40 });
    subEl.textContent = node.subtitle;
    g.appendChild(subEl);

    g.addEventListener('click', () => onNodeClick(node.id));
    g.addEventListener('mouseenter', (e) => onNodeHover(node.id, e));
    g.addEventListener('mouseleave', () => onNodeLeave(node.id));
    g.addEventListener('mousemove', (e) => moveTooltip(e));

    nodeGroup.appendChild(g);
  }
  canvas.appendChild(nodeGroup);
}

function applyVisualState() {
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

    if (type === 'hard' && fromInScope && toInScope) {
      // The edge is a reason something is in scope.
      if (state.selected.has(to)) edgeState = 'feeds-selected';
      else if (state.derived.required.has(to)) edgeState = 'active-required';
    } else if (type === 'soft' && fromInScope && !toInScope) {
      // Soft suggestion edge
      edgeState = 'active-soft';
    }

    p.setAttribute('data-state', edgeState);

    // Hover overlays
    if (state.hoveredId) {
      if (from === state.hoveredId) p.setAttribute('data-hover', 'dep');
      else if (to === state.hoveredId) p.setAttribute('data-hover', 'dependent');
      else p.removeAttribute('data-hover');
    } else {
      p.removeAttribute('data-hover');
    }
  });
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

  // Hover the canvas node from the drawer row
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
    for (const id of [...selectedIds, ...requiredIds]) {
      weight += state.nodesById.get(id)?.weight || 0;
    }
    let bucket;
    if (weight <= 25) bucket = 'Lean · ~3 months';
    else if (weight <= 60) bucket = 'Standard · ~6 months';
    else if (weight <= 110) bucket = 'Large · ~12 months';
    else bucket = 'Platform · 18+ months';
    document.getElementById('stats-weight').textContent = weight;
    document.getElementById('stats-bucket').textContent = bucket;
  }
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
  const m = document.createElement('div');
  m.className = 'tt-meta';
  m.textContent = `${state.layerById.get(node.layer)?.title ?? node.layer} · ${node.category} · weight ${node.weight}`;
  tt.appendChild(t);
  tt.appendChild(s);
  tt.appendChild(d);
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

function exportJson() {
  const requiredIds = [...state.derived.required];
  const selectedIds = [...state.selected];
  let weight = 0;
  for (const id of [...selectedIds, ...requiredIds]) {
    weight += state.nodesById.get(id)?.weight || 0;
  }
  const payload = {
    timestamp: new Date().toISOString(),
    selected: selectedIds,
    required: requiredIds,
    soft_suggestions: [...state.derived.softSuggestions],
    total_weight: weight,
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
  document.getElementById('export-btn').addEventListener('click', exportJson);
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

  layout();

  // Restore selection: URL > storage
  const fromUrl = readUrl();
  const fromStorage = readStorage();
  if (fromUrl && fromUrl.length) {
    state.selected = new Set(fromUrl.filter(id => state.nodesById.has(id)));
  } else if (fromStorage && Array.isArray(fromStorage)) {
    state.selected = new Set(fromStorage.filter(id => state.nodesById.has(id)));
  }

  renderFilterChips();
  renderPresetPicker();
  renderCanvas();
  recompute();
  applyVisualState();
  renderDrawer();
  wire();
}

document.addEventListener('DOMContentLoaded', boot);
