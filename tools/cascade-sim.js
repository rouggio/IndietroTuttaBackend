// Algorithm harness for the pane cascade: mirrors the logic in
// public/app.js (avoidPanelOverlap / settleAllPanels / the loadUI panelPos
// restore) with stubbed geometry. This proves the ALGORITHM, not the
// integration — there is still no browser in this environment.
const PANEL_IDS = ["device-panel", "wind-panel", "course-panel", "clean-panel"];
const rectsOverlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const VW = 1200;
let VH = 800;   // mutable so a case can simulate a taller viewport

function pane(id, left, top, w = 260, h = 300) {
  // rect() must read the CURRENT position, not the constructor args, or a
  // simulated move is invisible to the next collision check.
  const p = { id, style: { left: left + "px", top: top + "px" }, dataset: {}, _left: left, _top: top, _w: w, _h: h,
              rect: () => ({ left: p._left, top: p._top, right: p._left + p._w, bottom: p._top + p._h, width: p._w, height: p._h }) };
  return p;
}
function visible(p) { return true; }

function avoidPanelOverlap(el, all) {
  if (!el || !visible(el)) return false;
  const canMove = !el.dataset.moved;
  let moved = false;
  for (let pass = 0; pass < 6; pass++) {
    let collision = null, rect = null;
    for (const id of PANEL_IDS) {
      if (id === el.id) continue;
      const o = all[id];
      if (!o || !visible(o)) continue;
      const r = el.rect();
      if (!r.width || !r.height) return moved;
      const q = o.rect();
      if (rectsOverlap(r, q)) { collision = q; rect = r; break; }
    }
    if (!collision) break;
    if (!canMove) break;
    const q = collision;
    const below = q.bottom + 8;
    const fitsBelow = below + rect.height <= VH - 8;
    const fitsRight = q.right + 8 + rect.width <= VW - 8;
    if (fitsBelow) {
      el.style.left = rect.left + "px"; el.style.top = below + "px"; el._top = below; el._left = rect.left;
    } else if (fitsRight) {
      el.style.left = (q.right + 8) + "px"; el.style.top = "58px"; el._left = q.right + 8; el._top = 58;
    } else break;
    el.dataset.autoPlaced = "1";
    delete el.dataset.moved;
    moved = true;
  }
  return moved;
}
function settleAllPanels(all) {
  let moved = false;
  for (const id of PANEL_IDS) {
    const el = all[id];
    if (!el || !visible(el)) continue;
    if (avoidPanelOverlap(el, all)) moved = true;
  }
  return moved;
}
// mirror of loadUI's restore
function restore(all, pos, autoList) {
  const auto = new Set(autoList || []);
  for (const [id, p] of Object.entries(pos)) {
    const el = all[id];
    if (!el || !p) continue;
    el._left = p.left; el._top = p.top;
    el.style.left = p.left + "px"; el.style.top = p.top + "px";
    if (auto.has(id)) el.dataset.autoPlaced = "1";
    else el.dataset.moved = "1";
  }
}
const overlapsLeft = (all) => {
  const vis = PANEL_IDS.map(id => all[id]).filter(Boolean);
  for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++)
    if (rectsOverlap(vis[i].rect(), vis[j].rect())) return [vis[i].id, vis[j].id];
  return null;
};

let fails = 0;
const check = (name, cond, extra = "") => { console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? " — " + extra : "")); if (!cond) fails++; };

console.log("--- Case 1: two panes restored on top of each other, both auto-placed ---");
{
  const all = { "device-panel": pane("device-panel", 900, 58), "wind-panel": pane("wind-panel", 900, 58),
                "course-panel": pane("course-panel", 400, 500), "clean-panel": pane("clean-panel", 400, 100) };
  restore(all, { "device-panel": { left: 900, top: 58 }, "wind-panel": { left: 900, top: 58 } }, ["device-panel", "wind-panel"]);
  check("both are eligible (not user-owned)", !all["device-panel"].dataset.moved && !all["wind-panel"].dataset.moved);
  settleAllPanels(all);
  check("no overlaps remain", overlapsLeft(all) === null, "leftover: " + JSON.stringify(overlapsLeft(all)));
  check("moved panes stay auto-placed (still eligible next reload)",
        all["wind-panel"].dataset.autoPlaced === "1" && !all["wind-panel"].dataset.moved);
  check("untouched pane not marked auto", all["clean-panel"].dataset.autoPlaced === undefined);
}
console.log("\n--- Case 2: OLD behaviour regression — auto panes wrongly frozen ---");
{
  const all = { "device-panel": pane("device-panel", 900, 58), "wind-panel": pane("wind-panel", 900, 58),
                "course-panel": pane("course-panel", 400, 500), "clean-panel": pane("clean-panel", 400, 100) };
  restore(all, { "device-panel": { left: 900, top: 58 }, "wind-panel": { left: 900, top: 58 } }, []); // legacy: both user-owned
  settleAllPanels(all);
  check("legacy user-owned panes are NOT auto-corrected", overlapsLeft(all) !== null, "overlap: " + JSON.stringify(overlapsLeft(all)));
}
console.log("\n--- Case 3: a hand-dragged pane keeps its spot but still blocks others ---");
{
  const all = { "device-panel": pane("device-panel", 900, 58), "wind-panel": pane("wind-panel", 900, 58),
                "course-panel": pane("course-panel", 400, 500), "clean-panel": pane("clean-panel", 400, 100) };
  restore(all, { "device-panel": { left: 900, top: 58 } }, []);           // user-placed
  restore(all, { "wind-panel": { left: 900, top: 58 } }, ["wind-panel"]); // auto-placed, same spot
  settleAllPanels(all);
  check("hand-dragged pane never moved", all["device-panel"]._top === 58 && all["device-panel"]._left === 900);
  check("auto pane cascaded away from it", all["wind-panel"]._top !== 58);
  check("no overlaps remain", overlapsLeft(all) === null, "leftover: " + JSON.stringify(overlapsLeft(all)));
}
console.log("\n--- Case 4: repeated reloads keep settling when there IS room ---");
{
  // Room to spare: 3 panes stack at y=58/366/674, needing ~974px + margin.
  VH = 1100;
  const all = { "device-panel": pane("device-panel", 900, 58), "wind-panel": pane("wind-panel", 900, 58),
                "course-panel": pane("course-panel", 900, 58), "clean-panel": pane("clean-panel", 400, 100) };
  let pos = { "device-panel": { left: 900, top: 58 }, "wind-panel": { left: 900, top: 58 }, "course-panel": { left: 900, top: 58 } };
  let auto = ["device-panel", "wind-panel", "course-panel"];
  let ok = true;
  for (let reload = 1; reload <= 5; reload++) {
    for (const id of PANEL_IDS) { const p = all[id]; if (pos[id]) { p._left = pos[id].left; p._top = pos[id].top; } }
    restore(all, pos, auto);
    settleAllPanels(all);
    const bad = overlapsLeft(all);
    if (bad) { ok = false; console.log(`   reload ${reload}: overlap ${JSON.stringify(bad)}`); }
    pos = {}; auto = [];
    for (const id of PANEL_IDS) { const p = all[id]; pos[id] = { left: p._left, top: p._top }; if (p.dataset.autoPlaced) auto.push(id); }
  }
  check("5 reload cycles, no overlap ever persists", ok);
  VH = 800;
}

console.log("\n--- Case 5: IMPOSSIBLE geometry converges instead of thrashing ---");
{
  // 3 x 300px tall panes cannot fit an 800px viewport (~916px needed).
  // "If possible" means: stop moving, stay put — not oscillate on reload.
  const all = { "device-panel": pane("device-panel", 900, 58), "wind-panel": pane("wind-panel", 900, 58),
                "course-panel": pane("course-panel", 900, 58), "clean-panel": pane("clean-panel", 400, 100) };
  let pos = { "device-panel": { left: 900, top: 58 }, "wind-panel": { left: 900, top: 58 }, "course-panel": { left: 900, top: 58 } };
  let auto = ["device-panel", "wind-panel", "course-panel"];
  const seen = new Set();
  for (let reload = 1; reload <= 4; reload++) {
    for (const id of PANEL_IDS) { const p = all[id]; if (pos[id]) { p._left = pos[id].left; p._top = pos[id].top; } }
    restore(all, pos, auto);
    settleAllPanels(all);
    seen.add(PANEL_IDS.filter(id => all[id]).map(id => `${id}@${all[id]._left},${all[id]._top}`).join("|"));
    pos = {}; auto = [];
    for (const id of PANEL_IDS) { const p = all[id]; pos[id] = { left: p._left, top: p._top }; if (p.dataset.autoPlaced) auto.push(id); }
  }
  check("layout is STABLE across reloads (no oscillation)", seen.size === 1, `${seen.size} distinct layouts seen`);
}
console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
