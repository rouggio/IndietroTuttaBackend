// chrome.js — split from app.js. Floating-panel drag + overlap cascade helpers.
// Load order is index.html script order; cross-file names resolve at call time.
// --- Floating panels: drag by header + no-overlap on show ---
function makeFloatingDraggable(el) {
    if (!el || el.dataset.draggable) return;
    const header = el.querySelector("h4");
    if (!header) return;
    el.dataset.draggable = "1";
    header.style.cursor = "move";
    header.style.userSelect = "none";
    header.style.touchAction = "none";
    let drag = null;
    header.addEventListener("pointerdown", e => {
        if (e.target.closest("button,input,select,a")) return;
        if (e.target.closest("[id$='Close']")) return; // × must stay clickable (preventDefault would eat the click)
        // bring the grabbed panel above its siblings
        bringPanelToFront(el);
        const r = el.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        // CSS docks panels with right:10px — with both left+right set the
        // browser squeezes the width to satisfy both. Left wins on drag.
        el.style.right = "auto";
        try { header.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
    });
    header.addEventListener("pointermove", e => {
        if (!drag) return;
        el.style.left = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth - 60)) + "px";
        el.style.top = Math.max(0, e.clientY - drag.dy) + "px";
        el.dataset.moved = "1"; // user owns the position from here on
        delete el.dataset.autoPlaced; // ...and it is no longer ours to move
    });
    const end = () => {
        if (!drag) return;
        drag = null;
        // The pointermove clamp only guards the grab edge (60px); a pane wider
        // than that still hangs off the right, and nothing limited `top` at
        // all. Settle it fully inside, then make that the pane's home: a
        // deliberate move always outranks the remembered position.
        clampPanelIntoView(el);
        setPanelAnchor(el);
        try { saveUI(); } catch {}
    };
    header.addEventListener("pointerup", end);
    header.addEventListener("pointercancel", end);
}
function panelVisible(el) {
    return !!el && el.style.display !== "none" && el.style.display !== "";
}

// Gap a clamped pane keeps from the viewport edge — same 8px the overlap
// cascade uses, so the two never disagree about where "inside" is.
const PANEL_MARGIN = 8;

// Where each pane is SUPPOSED to be: the last position you (or the overlap
// cascade) actually chose. The clamp above is a visual correction and never
// touches this, so shrinking the window nudges panes aside without destroying
// their home — and growing it again walks every pane back on its own.
//
// Without it the resize handler had to persist the corrected position (the
// only thing left to save), which meant one shrink permanently rewrote your
// layout. saveUI() reads THIS, not the live style, so an unrelated save while
// the window is small cannot capture the clamped position either.
const panelAnchors = new Map(); // id -> {left, top} in px

function panelSize(el) {
    const r = el.getBoundingClientRect();
    return (!r.width || !r.height) ? null : { w: r.width, h: r.height, left: r.left, top: r.top };
}
function anchorFor(el) {
    const a = panelAnchors.get(el.id);
    return (a && isFinite(a.left) && isFinite(a.top)) ? a : null;
}
// Remember the pane's current position as its home. Called after a deliberate
// move (drag end, cascade placement, restore) — never after a clamp.
function setPanelAnchor(el) {
    if (!el || !el.id) return null;
    const left = parseFloat(el.style.left), top = parseFloat(el.style.top);
    if (!isFinite(left) || !isFinite(top)) return null;
    const a = { left, top };
    panelAnchors.set(el.id, a);
    return a;
}
// The position to persist for a pane: its home, falling back to where it
// actually is (a pane that has never been positioned keeps the CSS right dock).
function panelSavedPos(el) {
    const a = anchorFor(el);
    if (a) return { left: a.left + "px", top: a.top + "px" };
    return (el.style.left && el.style.top) ? { left: el.style.left, top: el.style.top } : null;
}
// Does this home still fit the viewport? An anchor that no longer fits is
// kept as-is (for a later, wider window) and merely clamped for now.
function anchorFits(a, size, margin) {
    if (a.left < margin || a.top < margin) return false;
    const maxLeft = window.innerWidth - size.w - margin;
    const maxTop = window.innerHeight - size.h - margin;
    if (maxLeft < margin || maxTop < margin) return false;
    return a.left <= maxLeft && a.top <= maxTop;
}

// Nudge a floating pane fully back inside the viewport, and say whether it
// moved. This is the ONE place that knows how to keep a pane reachable:
// the drag handlers, the restore path, the cascade and the resize listener
// all call it instead of each inventing a partial clamp (which is how a pane
// ended up with its close button off-screen in the first place).
//
// Ownership is deliberately untouched: a hand-placed pane stays
// `dataset.moved`, so the cascade still refuses to relocate it. Correcting an
// unreachable position is not handing the pane back to the auto-placer.
function clampPanelIntoView(el, margin = PANEL_MARGIN) {
    if (!el || !panelVisible(el)) return false;
    const r = el.getBoundingClientRect();
    // Not laid out yet (display just switched on, content still loading):
    // acting on a zero-size box would compute nonsense.
    if (!r.width || !r.height) return false;
    const maxLeft = window.innerWidth - r.width - margin;
    const maxTop = window.innerHeight - r.height - margin;
    // A pane wider/taller than the viewport cannot fit: pin it to the margin
    // instead of computing a negative maximum, which would flip it off the
    // opposite edge.
    const wantLeft = maxLeft < margin ? margin : Math.min(Math.max(r.left, margin), maxLeft);
    const wantTop = maxTop < margin ? margin : Math.min(Math.max(r.top, margin), maxTop);
    if (Math.abs(wantLeft - r.left) < 1 && Math.abs(wantTop - r.top) < 1) return false;
    el.style.right = "auto"; // left/top win over the CSS right dock
    el.style.left = Math.round(wantLeft) + "px";
    el.style.top = Math.round(wantTop) + "px";
    return true;
}

// Every floating pane, plus the per-boat Leaflet panels (which are not in
// PANEL_IDS because they are not persisted, but can still be dragged off the
// edge — they just heal on reload instead).
function clampAllPanelsIntoView() {
    let moved = false;
    for (const id of PANEL_IDS) {
        if (clampPanelIntoView(document.getElementById(id))) moved = true;
    }
    try {
        for (const panel of boatPanels.values()) {
            // panel.control is the L.Control; the draggable element is its _div.
            if (clampPanelIntoView(panel.control && panel.control._div)) moved = true;
        }
    } catch {}
    return moved;
}

// The resize path, and only the resize path, prefers a pane's home over
// wherever it is currently sitting: if the anchor fits the new viewport the
// pane goes home, otherwise it is clamped for now and keeps its anchor. A
// pane with no anchor (never positioned) is only clamped.
function reconcilePanelInView(el, margin = PANEL_MARGIN) {
    if (!el || !panelVisible(el)) return false;
    const size = panelSize(el);
    if (!size) return false;
    const a = anchorFor(el);
    if (a && anchorFits(a, size, margin)) {
        if (Math.abs(a.left - size.left) < 1 && Math.abs(a.top - size.top) < 1) return false;
        el.style.right = "auto";
        el.style.left = Math.round(a.left) + "px";
        el.style.top = Math.round(a.top) + "px";
        return true;
    }
    return clampPanelIntoView(el, margin);
}
function reconcileAllPanels() {
    let moved = false;
    for (const id of PANEL_IDS) {
        if (reconcilePanelInView(document.getElementById(id))) moved = true;
    }
    try {
        for (const panel of boatPanels.values()) {
            if (reconcilePanelInView(panel.control && panel.control._div)) moved = true;
        }
    } catch {}
    return moved;
}

// Window resize had NO handler: shrink the window and every pane stayed put,
// so several became unreachable at once. Nudge, do not re-cascade — a resize
// must never scatter the layout the user arranged. Debounced, because resize
// fires in bursts and each pass reads layout.
//
// No saveUI here: reconciliation never changes an anchor, so there is nothing
// new to persist. Saving the live (clamped) positions is exactly what used to
// rewrite the user's layout on every shrink.
let panelClampTimer = null;
window.addEventListener("resize", () => {
    if (panelClampTimer) clearTimeout(panelClampTimer);
    panelClampTimer = setTimeout(() => {
        panelClampTimer = null;
        reconcileAllPanels();
    }, 120);
});
function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
// Every floating pane, in the canonical order used for cascading. Keep this
// list complete: a pane missing here is invisible to the overlap logic.
const PANEL_IDS = [
    "device-panel", "wind-panel", "course-panel", "session-panel",
    "session-create-panel", "session-detail-panel", "settings-panel",
    "clean-panel", "features-panel", "builder-panel",
];

// If el (just shown/grown) covers another open floating panel, cascade it
// below; if that runs off-screen, dock it right of the other panel instead.
// Panels the user dragged themselves are never auto-moved.
//
// Returns true when the panel was actually relocated. When there is no room
// to clear the collision the panel is left exactly where it is — a pane
// that jitters between positions every time one is restored is worse than a
// pane that overlaps once.
function avoidPanelOverlap(el) {
    if (!el || !panelVisible(el)) return false;
    // A pane the user dragged by hand stays exactly where it is — but it is
    // still an OBSTACLE, so other panes must cascade around it.
    const canMove = !el.dataset.moved;
    let moved = false;
    // One greedy pass is not enough: moving clear of obstacle A can drop the
    // pane straight into obstacle B, which did not overlap a moment ago.
    // Re-scan from the top after every move until nothing collides or we run
    // out of attempts.
    for (let pass = 0; pass < 6; pass++) {
        let collision = null, rect = null;
        for (const id of PANEL_IDS) {
            if (id === el.id) continue;
            const o = document.getElementById(id);
            if (!o || !panelVisible(o)) continue;
            const r = el.getBoundingClientRect();
            // Not laid out yet (display just switched on, or content not
            // populated): acting on a zero-size box cascades to a bogus spot.
            if (!r.width || !r.height) return moved;
            const q = o.getBoundingClientRect();
            if (rectsOverlap(r, q)) { collision = q; rect = r; break; }
        }
        if (!collision) break;          // clear of everything
        if (!canMove) break;            // hand-placed: it keeps its spot

        const q = collision;
        const below = q.bottom + 8;
        const fitsBelow = below + rect.height <= window.innerHeight - 8;
        const fitsRight = q.right + 8 + rect.width <= window.innerWidth - 8;
        if (fitsBelow) {
            el.style.right = "auto"; // left wins over CSS right dock
            el.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)) + "px";
            el.style.top = below + "px";
        } else if (fitsRight) {
            el.style.right = "auto";
            el.style.left = (q.right + 8) + "px";
            el.style.top = "58px";
        } else {
            break; // no room anywhere — leave it, stop trying
        }
        // Ours, not the user's: record that so a reload keeps this pane
        // eligible for the next cascade instead of freezing it in place.
        el.dataset.autoPlaced = "1";
        delete el.dataset.moved;
        // The spot the cascade chose is this pane's home — auto-placed panes
        // walk back to it on resize exactly like hand-placed ones do.
        setPanelAnchor(el);
        moved = true;
    }
    // Last resort: the loop gave up (no room, or a hand-placed pane we may
    // not relocate). The pane can still be UNREACHABLE, so make sure it is at
    // least inside the viewport.
    if (clampPanelIntoView(el)) moved = true;
    return moved;
}

// Full pass over every visible pane, in PANEL_IDS order, so the outcome does
// not depend on which pane happened to be restored or opened first.
// Used after loadUI() restores visibility: at that point several panes can
// come back at the same stale coordinates.
function settleAllPanels() {
    let moved = false;
    for (const id of PANEL_IDS) {
        const el = document.getElementById(id);
        if (!el || !panelVisible(el)) continue;
        if (avoidPanelOverlap(el)) moved = true;
    }
    if (moved) { try { saveUI(); } catch {} }
    return moved;
}

// Panes restore their content asynchronously (loadCourses, loadFeatures,
// refreshWind), so their heights grow after the DOM settles. Two passes:
// one as soon as layout is real, one after the async content has landed.
function settleAllPanelsWhenReady() {
    requestAnimationFrame(() => {
        settleAllPanels();
        setTimeout(settleAllPanels, 400);
    });
}
