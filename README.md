# Opal Feature Explorer

Static single-page web app that displays the complete Opal feature graph (71 nodes, 144 edges, 10 layers, 8 maturity ladders, 4 presets). Two views:

- **Architecture** — swim-lane DAG by layer.
- **Ladders** — same nodes re-arranged by capability dimension and tier.

Click any feature to add it to a working scope; the page pulls in every transitive `hard` and `progresses` dependency, suggests `soft` enhancements, and surfaces what would unlock next.

## Run locally

The app is plain HTML / CSS / JS. There is no build step. It only needs to be served over HTTP (so the browser will let it `fetch` the JSON).

```bash
# any static server works — pick one
python3 -m http.server 5173
# or
npx serve .
```

Then open `http://localhost:5173`.

Opening `index.html` directly via `file://` will fail because of `fetch` of the JSON file.

## Files

```
opal-explorer/
├── index.html               # Page shell — topbar, canvas wrap, drawer
├── style.css                # All styles, tokens, dark mode
├── app.js                   # Load → layout → render → recompute → interactions
├── opal_feature_graph.json  # Canonical graph data (nodes, edges, presets)
├── opal_explorer_spec.md    # Source spec
└── README.md                # This file
```

## Editing the graph

`opal_feature_graph.json` is the source of truth. To add a feature:

1. Append a node to `nodes[]` with a unique kebab-case `id`.
2. Add edges from the new node to its hard / soft dependencies (`from` depends on `to`).
3. Reload the page — layout regenerates automatically.

### DAG validation

The graph must remain a DAG on hard edges. Quick check in the browser console:

```js
function findCycle(nodes, edges) {
  const fromMap = new Map();
  for (const e of edges.filter(x => x.type === 'hard')) {
    if (!fromMap.has(e.from)) fromMap.set(e.from, []);
    fromMap.get(e.from).push(e.to);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(nodes.map(n => [n.id, WHITE]));
  function dfs(id, stack) {
    if (color.get(id) === GRAY) return [...stack, id];
    if (color.get(id) === BLACK) return null;
    color.set(id, GRAY);
    for (const next of fromMap.get(id) || []) {
      const c = dfs(next, [...stack, id]);
      if (c) return c;
    }
    color.set(id, BLACK);
    return null;
  }
  for (const n of nodes) {
    const c = dfs(n.id, []);
    if (c) return c;
  }
  return null;
}
// fetch('opal_feature_graph.json').then(r => r.json()).then(g => console.log(findCycle(g.nodes, g.edges)));
```

A return value of `null` means no cycles.

## Sharing scopes

The current selection lives in the URL hash as a comma-separated id list. Copying the URL and sharing it shares the full scope. The "Copy share link" button in the drawer does this in one click.

Selections are also mirrored into `localStorage['opal-explorer-selection']`; URL takes precedence on load.

## Browser targets

Modern evergreen Chrome 110+, Safari 16+, Firefox 110+. Uses CSS variables, nested rules sparingly, and SVG. No transpilation, no dependencies.
