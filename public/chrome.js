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
        try { saveUI(); } catch {}
    };
    header.addEventListener("pointerup", end);
    header.addEventListener("pointercancel", end);
}
function panelVisible(el) {
    return !!el && el.style.display !== "none" && el.style.display !== "";
}
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
        moved = true;
    }
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
