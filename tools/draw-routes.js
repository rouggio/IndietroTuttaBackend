// ------------------------------------------------------------------
// draw-routes.js — disegna la rotta che il simulatore fa percorrere,
// corso per corso, così si può controllare a occhio che passi dalla
// parte giusta di ogni boa e che NON giri in tondo.
//
// Gira in locale, senza server: legge i corsi dal database e scrive un
// SVG per corso più un indice in `out/sim-routes/`.
//
//   node tools/draw-routes.js                 (tutti i corsi)
//   node tools/draw-routes.js 35 42           (solo alcuni, per id)
//
// Il disegno è in «coordinate vento»: x verso destra, y verso
// l'alto = sopravento. È la forma del percorso, la stessa cosa che
// vede il costruttore di corsi; in acqua viene solo ruotata secondo il
// vento e spostata sul punto di partenza.
// ------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const { listCourses } = require("../store/courseStore");
const { shapeOfCourse, compileShapeRoute, resolveRoute } = require("../store/simShape");

const OUT_DIR = path.join(__dirname, "..", "out", "sim-routes");
const ROUNDING_M = 15;      // metri di passaggio dalla boa (lo stesso del generatore)
const HOLD_M = 300;         // attesa prima della partenza (metri dietro la linea)
const OVERRUN_M = 200;      // quanto prosegue oltre l'arrivo

// --------------------------------------------------------------- utilità

const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const n1 = v => (Math.round(v * 10) / 10).toFixed(1);
const n0 = v => String(Math.round(v));

// Passo della griglia «bello» per una campata data.
function gridStep(span) {
    for (const s of [25, 50, 100, 200, 250, 500, 1000]) if (span / s <= 12) return s;
    return 2000;
}

const sideWord = s => (s === "P" ? "sinistra" : s === "S" ? "destra" : "indifferente");

// -------------------------------------------------------- geometria piana
// Tutto in coordinate vento: metri, x est, y sopravento.

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = v => Math.hypot(v.x, v.y);
const dot = (a, b) => a.x * b.x + a.y * b.y;

// Punto più vicino su UN segmento, con il lato (segno del prodotto
// vettoriale: > 0 = punto a sinistra di chi naviga da a verso b).
function closestOnSeg(a, b, p) {
    const d = sub(b, a);
    const L2 = dot(d, d);
    if (L2 < 1e-9) return { dist: len(sub(p, a)), point: { ...a }, cross: 0 };
    let t = dot(sub(p, a), d) / L2;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + d.x * t, y: a.y + d.y * t };
    return {
        dist: len(sub(p, q)),
        point: q,
        cross: d.x * (p.y - a.y) - d.y * (p.x - a.x),
    };
}

// Punto più vicino dell'intera spezzata (distanza minima vera).
function closestApproach(poly, p) {
    let best = null;
    for (let i = 0; i + 1 < poly.length; i++) {
        const c = closestOnSeg(poly[i], poly[i + 1], p);
        if (!best || c.dist < best.dist) best = c;
    }
    return best;
}

// Spezzata fitta (un punto ogni ~5 m) per misurare la rotazione attorno
// alla boa come la vede il device, non solo sui vertici.
function densify(poly, stepM = 5) {
    const dense = [poly[0]];
    const at = [0];
    for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1], b = poly[i];
        const L = len(sub(b, a));
        const n = Math.max(1, Math.round(L / stepM));
        for (let k = 1; k <= n; k++) {
            dense.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
        }
        at.push(dense.length - 1);
    }
    return { dense, at };
}

// Di quanto la boa ruota attorno alla barca fra due punti della rotta:
// quanto varia il rilevamento (barca → boa). È la misura che usa il
// device per dire «boa girata».
function sweepAround(poly, from, to, buoy) {
    const brg = p => {
        const d = sub(buoy, p);
        return (Math.atan2(d.x, d.y) * 180) / Math.PI;   // 0° = boa a nord della barca
    };
    let prev = null, total = 0, min = Infinity, max = -Infinity;
    const lo = Math.max(0, from), hi = Math.min(poly.length - 1, to);
    for (let i = lo; i <= hi; i++) {
        const b = brg(poly[i]);
        if (prev !== null) {
            let d = b - prev;
            while (d > 180) d -= 360;
            while (d < -180) d += 360;
            total += d;
        }
        prev = b;
        min = Math.min(min, total);
        max = Math.max(max, total);
    }
    return { sweep: total, range: max - min };
}

// ------------------------------------------------------------- analisi
// Per ogni boa (o porta) del percorso: come passa la rotta, da che lato,
// a che distanza, e di quanto ruota attorno alla boa.
//
// Il LATO si legge sul lato di AVVICINAMENTO (il leg che finisce sul
// waypoint della boa): è lì che il generatore mira fuori asse, mentre al
// waypoint la boa è esattamente al traverso e i due lati si equivalgono.
function analyze(shape, route) {
    const poly = route.map(w => ({ x: w.x, y: w.y }));
    const { dense, at } = densify(poly);
    const rows = [];
    route.forEach((w, i) => {
        if (w.kind !== "mark" && w.kind !== "gate") return;
        const centre = { x: w.cx !== undefined ? w.cx : w.x, y: w.cy !== undefined ? w.cy : w.y };
        const ca = closestApproach(dense, centre);
        const inLeg = i > 0 ? closestOnSeg(poly[i - 1], poly[i], centre) : ca;
        const from = at[Math.max(0, i - 1)], to = at[Math.min(at.length - 1, i + 1)];
        const sw = sweepAround(dense, from, to, centre);
        rows.push({
            label: w.kind === "gate" ? "porta" : "B" + (w.ref + 1),
            index: w.ref,
            kind: w.kind,
            required: w.side || null,
            passed: inLeg.cross > 0 ? "P" : "S",    // >0 = boa a sinistra
            dist: ca.dist,                          // distanza minima su tutto il percorso
            passDist: inLeg.dist,                   // distanza nel punto di passaggio
            sweep: sw.sweep,
            range: sw.range,
            point: inLeg.point,                     // dove la barca gira la boa
            nearPoint: ca.point,                    // dove le si avvicina di più (può essere altrove)
            centre,
        });
    });
    return rows;
}

// ------------------------------------------------------------ disegno
// Punti fuori percorso disegnati insieme alla rotta: l'attesa dietro la
// linea e il pezzo che si percorre oltre l'arrivo.
function extras(route) {
    const poly = route.map(w => ({ x: w.x, y: w.y }));
    const l0 = poly[0], first = poly.length > 1 ? poly[1] : poly[0];
    const d0 = sub(first, l0), L0 = len(d0) || 1;
    const hold = { x: l0.x - (d0.x / L0) * HOLD_M, y: l0.y - (d0.y / L0) * HOLD_M };
    const last = poly[poly.length - 1], prevLast = poly[poly.length - 2] || last;
    const dE = sub(last, prevLast), LE = len(dE) || 1;
    const over = { x: last.x + (dE.x / LE) * OVERRUN_M, y: last.y + (dE.y / LE) * OVERRUN_M };
    return { poly, hold, over, last, prevLast };
}

function panelGeom(shape, route, ex) {
    const pts = [];
    const add = (x, y, r) => pts.push({ x: x - (r || 0), y: y - (r || 0) }, { x: x + (r || 0), y: y + (r || 0) });
    (shape.marks || []).forEach(m => add(m.x, m.y, m.r || 20));
    [shape.startLine, shape.finishLine && shape.finishLine.sameAs ? null : shape.finishLine]
        .forEach(s => { if (s && !s.sameAs) { add(s.ax, s.ay, 0); add(s.bx, s.by, 0); } });
    route.forEach(w => add(w.x, w.y, 0));
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    // L'attesa e il proseguimento oltre l'arrivo NON entrano nella
    // inquadratura: sono 500 m su un percorso che ne misura 700 e
    // schiaccerebbero il disegno. Si disegnano come brevi trattini con
    // la misura scritta accanto.
    const pad = 64;
    const k = Math.min(1000 / Math.max(1, maxX - minX), 900 / Math.max(1, maxY - minY));
    const drawW = (maxX - minX) * k + 2 * pad;
    const drawH = (maxY - minY) * k + 2 * pad;
    const mx = x => pad + (x - minX) * k;
    const my = y => drawH - pad - (y - minY) * k;
    return { minX, maxX, minY, maxY, k, drawW, drawH, mx, my, pad };
}

function legArrow(a, b, mx, my, colour) {
    const x1 = mx(a.x), y1 = my(a.y), x2 = mx(b.x), y2 = my(b.y);
    const ax = (x1 + x2) / 2, ay = (y1 + y2) / 2;
    const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    const s = 9;
    return `<path d="M ${ax - s * Math.cos((ang - 25) * Math.PI / 180)} ${ay - s * Math.sin((ang - 25) * Math.PI / 180)} L ${ax} ${ay} L ${ax - s * Math.cos((ang + 25) * Math.PI / 180)} ${ay - s * Math.sin((ang + 25) * Math.PI / 180)}" fill="none" stroke="${colour}" stroke-width="2.2" stroke-linecap="round"/>`;
}

// -------------------------------------------------- sistema le etichette
// Sui percorsi stretti (un sopravento-sottovento è un fuso verticale di
// poche decine di metri) le scritte finiscono una sopra l'altra. Questo
// piazzatore prova le posizioni attorno al punto, in tondo, e prende la
// prima libera: le etichette che contano si posano per prime.
function makePlacer() {
    const boxes = [];
    const hits = b => boxes.some(o => !(b.x + b.w < o.x || o.x + o.w < b.x || b.y + b.h < o.y || o.y + o.h < b.y));
    return {
        // occupa un rettangolo (punti già disegnati: boe, linea, ...)
        hold(x, y, w, h) { boxes.push({ x, y, w, h }); },
        label(text, x, y, dist, fontW = 6.7, allowFallback = true) {
            const bw = String(text).length * fontW + 10, bh = 15;
            const angles = [90, 270, 0, 180, 45, 315, 135, 225, 60, 300, 120, 240];
            for (const d of [dist, dist + 12, dist + 26]) {
                for (const a of angles) {
                    const rad = (a * Math.PI) / 180;
                    const cx = x + Math.cos(rad) * d;
                    const cy = y + Math.sin(rad) * d * 0.75;
                    const b = { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
                    if (!hits(b)) { boxes.push(b); return { x: cx, y: cy + 4, anchor: "middle" }; }
                }
            }
            if (!allowFallback) return null;   // meglio niente che una scritta sopra l'altra
            const b = { x: x - bw / 2, y: y - bh / 2, w: bw, h: bh };
            boxes.push(b);
            return { x: x, y: y + 4, anchor: "middle" };
        },
    };
}

function drawCourse(course, shape, route, rows) {
    const ex = extras(route);
    const g = panelGeom(shape, route, ex);
    const { mx, my, pad, drawW, drawH, k } = g;
    const placer = makePlacer();

    // --- griglia + righello
    const span = Math.max(g.maxX - g.minX, g.maxY - g.minY);
    const step = gridStep(span);
    let grid = "";
    for (let x = Math.ceil(g.minX / step) * step; x <= g.maxX; x += step) {
        grid += `<line x1="${mx(x).toFixed(1)}" y1="0" x2="${mx(x).toFixed(1)}" y2="${drawH.toFixed(1)}" stroke="#eef1f4"/>`;
    }
    for (let y = Math.ceil(g.minY / step) * step; y <= g.maxY; y += step) {
        grid += `<line x1="0" y1="${my(y).toFixed(1)}" x2="${drawW.toFixed(1)}" y2="${my(y).toFixed(1)}" stroke="#eef1f4"/>`;
    }
    const barPx = step * k;
    const ruler = `<g>
      <line x1="${pad}" y1="${drawH - 18}" x2="${pad + barPx}" y2="${drawH - 18}" stroke="#94a3b8" stroke-width="2"/>
      <line x1="${pad}" y1="${drawH - 23}" x2="${pad}" y2="${drawH - 13}" stroke="#94a3b8" stroke-width="2"/>
      <line x1="${pad + barPx}" y1="${drawH - 23}" x2="${pad + barPx}" y2="${drawH - 13}" stroke="#94a3b8" stroke-width="2"/>
      <text x="${pad + barPx / 2}" y="${drawH - 24}" font-size="12" fill="#64748b" text-anchor="middle">${step} m</text>
    </g>`;

    // --- vento: freccia verso il basso (il vento arriva dall'alto)
    const wind = `<g transform="translate(24,24)">
      <text x="0" y="0" font-size="12" fill="#64748b">SOPRAVENTO</text>
      <line x1="26" y1="12" x2="26" y2="54" stroke="#0ea5e9" stroke-width="2.5"/>
      <path d="M 20 46 L 26 56 L 32 46" fill="none" stroke="#0ea5e9" stroke-width="2.5" stroke-linejoin="round"/>
      <text x="36" y="38" font-size="12" fill="#0ea5e9">vento</text>
      <text x="0" y="${drawH - 6}" font-size="12" fill="#64748b">SOTTOVENTO</text>
    </g>`;

    // --- linea di partenza / arrivo
    const sl = shape.startLine;
    const fl = shape.finishLine && shape.finishLine.sameAs === "start" ? shape.startLine : shape.finishLine;

    // Prima si prenota lo spazio di quello che è già disegnato (boe e
    // linee), così le scritte si mettono attorno e non sopra.
    (shape.marks || []).forEach(m => placer.hold(mx(m.x) - 9, my(m.y) - 9, 18, 18));
    [sl, fl].forEach(s => {
        if (!s || s.sameAs) return;
        const x1 = mx(s.ax), y1 = my(s.ay), x2 = mx(s.bx), y2 = my(s.by);
        placer.hold(Math.min(x1, x2) - 7, Math.min(y1, y2) - 7, Math.abs(x2 - x1) + 14, Math.abs(y2 - y1) + 14);
    });

    let lineLayer = "";
    const drawLine = (seg, colour, label) => {
        if (!seg || seg.sameAs) return;
        const x1 = mx(seg.ax), y1 = my(seg.ay), x2 = mx(seg.bx), y2 = my(seg.by);
        lineLayer += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${colour}" stroke-width="4" stroke-linecap="round"/>`;
        lineLayer += `<circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="5" fill="${colour}"/><circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="5" fill="${colour}"/>`;
        const p = placer.label(label, (x1 + x2) / 2, (y1 + y2) / 2, 34);
        lineLayer += `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" font-size="13" font-weight="600" fill="${colour}" text-anchor="${p.anchor}">${esc(label)}</text>`;
    };
    const sameFinish = !!(shape.finishLine && shape.finishLine.sameAs === "start");
    if (sl && fl && !sameFinish && (fl.ax !== sl.ax || fl.ay !== sl.ay || fl.bx !== sl.bx || fl.by !== sl.by)) {
        drawLine(sl, "#1d4ed8", "partenza");
        drawLine(fl, "#7c3aed", "arrivo");
    } else {
        drawLine(sl, "#1d4ed8", "partenza / arrivo");
    }

    // --- boe
    const gateGroups = {};
    (shape.marks || []).forEach((m, i) => {
        if (m.type === "gate" && m.gate) (gateGroups[m.gate] = gateGroups[m.gate] || []).push(i);
    });
    let markLayer = "";
    (shape.marks || []).forEach((m, i) => {
        const x = mx(m.x), y = my(m.y);
        const r = (m.r || 0) * k;
        markLayer += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="#cbd5e1" stroke-dasharray="3 4"/>`;
        markLayer += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.5" fill="#111827"/>`;
        const p = placer.label(`B${i + 1}`, x, y, Math.max(16, r + 13));
        markLayer += `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" font-size="13" font-weight="700" fill="#111827" text-anchor="${p.anchor}">B${i + 1}</text>`;
    });
    Object.values(gateGroups).forEach(pair => {
        if (pair.length !== 2) return;
        const a = shape.marks[pair[0]], b = shape.marks[pair[1]];
        markLayer += `<line x1="${mx(a.x).toFixed(1)}" y1="${my(a.y).toFixed(1)}" x2="${mx(b.x).toFixed(1)}" y2="${my(b.y).toFixed(1)}" stroke="#7c3aed" stroke-width="2.5" stroke-dasharray="6 4"/>`;
        const cx = (mx(a.x) + mx(b.x)) / 2, cy = (my(a.y) + my(b.y)) / 2;
        const p = placer.label("porta", cx, cy, 22);
        markLayer += `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" font-size="12" font-weight="700" fill="#7c3aed" text-anchor="${p.anchor}">porta</text>`;
    });

    // --- rotta: percorso + due trattini (attesa e proseguimento), con la
    // misura scritta accanto invece che disegnati in scala.
    const { poly, hold, last, over } = ex;
    const pts = poly.map(p => `${mx(p.x).toFixed(1)},${my(p.y).toFixed(1)}`).join(" ");
    let routeLayer = `<polyline points="${pts}" fill="none" stroke="#ea580c" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
    const stub = (from, dir, colour, dash, label) => {
        const ux0 = dir.x * k, uy0 = -dir.y * k;
        const L = Math.hypot(ux0, uy0) || 1;
        const ux = ux0 / L, uy = uy0 / L;
        const x1 = mx(from.x), y1 = my(from.y);
        const x2 = x1 + ux * 54, y2 = y1 + uy * 54;
        const p = placer.label(label, x2, y2, 16);
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${colour}" stroke-width="3" stroke-dasharray="${dash}" stroke-linecap="round"/>`
            + `<circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="5" fill="#fff" stroke="${colour}" stroke-width="2.5"/>`
            + `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" font-size="12" fill="${colour}" text-anchor="${p.anchor}">${esc(label)}</text>`;
    };
    routeLayer += stub(poly[0], { x: poly[0].x - hold.x, y: poly[0].y - hold.y }, "#d97706", "7 5", `attesa ${HOLD_M} m dietro la linea`);
    routeLayer += stub(last, { x: over.x - last.x, y: over.y - last.y }, "#c2410c", "7 5", `prosegue ${OVERRUN_M} m oltre l'arrivo`);
    for (let i = 0; i + 1 < poly.length; i++) routeLayer += legArrow(poly[i], poly[i + 1], mx, my, "#ea580c");

    // --- passaggi dalle boe: cerchietto sul punto di passaggio, legame
    // alla boa, e la distanza scritta attorno (mai sopra la boa).
    let passLayer = "";
    for (const r of rows) {
        const p = r.point, c = r.centre;
        const px = mx(p.x), py = my(p.y);
        // il cerchietto del passaggio è già disegnato: la misura sta attorno
        placer.hold(px - 9, py - 9, 18, 18);
        passLayer += `<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${mx(c.x).toFixed(1)}" y2="${my(c.y).toFixed(1)}" stroke="#94a3b8" stroke-width="1.4" stroke-dasharray="3 3"/>`;
        passLayer += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6" fill="#fff" stroke="#ea580c" stroke-width="2.5"/>`;
        const lp = placer.label(n1(r.dist) + " m", px, py, 20, 6.2);
        passLayer += `<text x="${lp.x.toFixed(1)}" y="${lp.y.toFixed(1)}" font-size="11.5" fill="#334155" text-anchor="${lp.anchor}">${n1(r.dist)} m</text>`;
        // se la barca passa vicino alla boa anche ALTROVE (non dove la gira),
        // quel punto si marca a parte: è lì che un arbitro guarderebbe
        if (r.dist < 10 && r.passDist - r.dist > 3) {
            const nx = mx(r.nearPoint.x), ny = my(r.nearPoint.y);
            passLayer += `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="5" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>`;
            const np = placer.label("ci passa sopra", nx, ny, 16, 6.2, false);
            if (np) passLayer += `<text x="${np.x.toFixed(1)}" y="${np.y.toFixed(1)}" font-size="11.5" font-weight="600" fill="#b45309" text-anchor="${np.anchor}">ci passa sopra</text>`;
        }
    }

    // --- tabella
    const t = tableFor(rows, course);
    return { svg: null, g, layers: { grid, ruler, wind, lineLayer, markLayer, routeLayer, passLayer }, table: t };
}

// ------------------------------------------------------------- tabella
function tableFor(rows, course) {
    const head = ["boa", "lato richiesto", "come passa", "distanza minima", "giro attorno alla boa"];
    const body = rows.map(r => {
        if (r.kind === "gate") {
            return { cells: [r.label, "porta da attraversare", "attraversa", n1(r.dist) + " m", n0(r.range) + "°"], ok: true, warn: false };
        }
        const w = r.passed === "P" ? "sinistra" : "destra";
        const req = r.required ? sideWord(r.required) : "indifferente";
        const ok = !r.required || r.required === r.passed;
        // La barca sfiora questa boa in un punto che non è il passaggio
        // voluto (tipico quando una boa sta sulla linea fra due altre):
        // vale la pena vederlo, perché il device potrebbe contarlo.
        const warn = r.dist < 10 && r.passDist - r.dist > 3;
        return {
            cells: [r.label, req, (ok ? "OK " : "NO ") + w, n1(r.dist) + " m" + (warn ? " !" : ""), n0(r.range) + "°"],
            ok,
            warn,
        };
    });
    return { head, body };
}

function tableSvg(table, x, y) {
    const cols = [70, 150, 150, 130, 190];
    let out = "";
    let cx = x;
    table.head.forEach((h, i) => {
        out += `<text x="${cx}" y="${y}" font-size="12" font-weight="700" fill="#334155">${esc(h)}</text>`;
        cx += cols[i];
    });
    table.body.forEach((row, ri) => {
        const ry = y + 20 + ri * 20;
        let px = x;
        row.cells.forEach((c, i) => {
            const colour = i === 2 ? (row.ok ? "#15803d" : "#b91c1c") : (i === 3 && row.warn ? "#b45309" : "#0f172a");
            const weight = i === 2 || (i === 3 && row.warn) ? "700" : "400";
            out += `<text x="${px}" y="${ry}" font-size="13" fill="${colour}" font-weight="${weight}">${esc(c)}</text>`;
            px += cols[i];
        });
    });
    return { svg: out, height: 20 + table.body.length * 20 };
}

// ------------------------------------------------------------- un corso
function renderCourse(course, shape, route, rows) {
    const { g, layers, table } = drawCourse(course, shape, route, rows);
    const { mx, my, drawW, drawH } = g;
    const titleH = 74;
    const headerH = 26;
    const tableH = 20 + table.body.length * 20 + 22;
    const noteH = 62;
    const W = Math.max(drawW, 760);
    const H = titleH + drawH + headerH + tableH + noteH;
    const offX = Math.round((W - drawW) / 2);
    const tbl = tableSvg(table, 40, titleH + drawH + headerH + 14);

    const bad = rows.some(r => r.required && r.required !== r.passed);
    const marks = (shape.marks || []).length;
    const lineLen = shape.startLine ? Math.hypot(shape.startLine.bx - shape.startLine.ax, shape.startLine.by - shape.startLine.ay) : 0;
    const total = route.slice(1).reduce((s, w, i) => s + Math.hypot(w.x - route[i].x, w.y - route[i].y), 0);

    const verdict = bad
        ? `<text x="${W - 40}" y="30" font-size="15" font-weight="700" fill="#b91c1c" text-anchor="end">passa dalla parte sbagliata</text>`
        : `<text x="${W - 40}" y="30" font-size="15" font-weight="700" fill="#15803d" text-anchor="end">passa dal lato giusto di ogni boa</text>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="40" y="30" font-size="21" font-weight="700" fill="#0f172a">${esc(course.name)} — corso #${course.id}</text>
  <text x="40" y="52" font-size="13" fill="#475569">${marks} boe · linea ${n0(lineLen)} m · percorso ${n0(total)} m · la barca passa a ${ROUNDING_M} m da ogni boa</text>
  ${verdict}
  <g transform="translate(${offX},${titleH})">
    ${layers.grid}${layers.ruler}${layers.wind}${layers.lineLayer}${layers.routeLayer}${layers.markLayer}${layers.passLayer}
  </g>
  <g transform="translate(0,${titleH + drawH})">
    <line x1="40" y1="0" x2="${W - 40}" y2="0" stroke="#e2e8f0"/>
    ${tbl.svg}
  </g>
  <g transform="translate(40,${titleH + drawH + headerH + tableH})">
    <text x="0" y="0" font-size="12" fill="#64748b">Dall'alto si vede la forma del percorso così com'è salvata: la barca entra dal basso, la linea blu è partenza</text>
    <text x="0" y="16" font-size="12" fill="#64748b">(e arrivo), i cerchi tratteggiati sono le boe, la linea arancione è la traccia della barca-simulatore. Il «giro»</text>
    <text x="0" y="32" font-size="12" fill="#64748b">è di quanto la boa ruota attorno alla barca mentre la si passa: se supera 150° il device la conta come girata.</text>
    <text x="0" y="48" font-size="12" fill="#b45309">Un «!» dopo la distanza vuol dire che la barca sfiora quella boa in un altro punto, non dove la gira.</text>
  </g>
</svg>
`;
}

// -------------------------------------------------------------- indice
function renderIndex(entries) {
    const rows = entries.map(e => {
        const bad = e.rows.some(r => r.required && r.required !== r.passed);
        const maxSweep = e.rows.length ? Math.max(...e.rows.map(r => r.range)) : 0;
        const minSweep = e.rows.length ? Math.min(...e.rows.map(r => r.range)) : 0;
        const worst = e.rows.reduce((a, r) => (r.range < a.range ? r : a), e.rows[0] || { range: 0 });
        return `<tr>
      <td>#${e.course.id}</td>
      <td><a href="${esc(e.file)}">${esc(e.course.name)}</a></td>
      <td>${e.marks}</td>
      <td>${n0(e.total)} m</td>
      <td class="${bad ? "bad" : "ok"}">${bad ? "lato sbagliato" : "lato giusto"}</td>
      <td>${n0(minSweep)}° – ${n0(maxSweep)}°</td>
      <td>${e.rows.length ? esc(worst.label) + " " + n0(worst.range) + "°" : "—"}</td>
    </tr>`;
    }).join("\n");
    return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Rotte del simulatore, corso per corso</title>
<style>
 body{font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;margin:24px;color:#0f172a}
 h1{font-size:20px;margin:0 0 4px}
 p.note{color:#475569;font-size:13px;margin:6px 0 18px;max-width:900px;line-height:1.5}
 table{border-collapse:collapse;font-size:13px}
 th,td{border-bottom:1px solid #e2e8f0;padding:6px 12px;text-align:left}
 th{background:#f8fafc;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#475569}
 a{color:#1d4ed8;text-decoration:none}
 a:hover{text-decoration:underline}
 .ok{color:#15803d;font-weight:600}
 .bad{color:#b91c1c;font-weight:700}
 code{background:#f1f5f9;padding:1px 4px;border-radius:3px}
</style></head><body>
<h1>Rotte del simulatore, corso per corso</h1>
<p class="note">Ogni figura mostra la forma del percorso (x verso destra, y verso l'alto = sopravento, la stessa vista
del costruttore di corsi) e la rotta che la barca-simulatore percorre: attesa dietro la linea, partenza, passaggio a
${ROUNDING_M} m dal lato giusto di ogni boa, arrivo e proseguimento oltre la linea. In acqua tutto questo viene solo
ruotato secondo il vento e spostato sul punto di partenza: la forma non cambia mai. Una figura per corso, il nome dice
quale è — l'id serve solo per ritrovarlo nell'elenco dei corsi.</p>
<p class="note">La colonna «giro» dice di quanto la boa ruota attorno alla barca mentre la si passa: il device
considera girata una boa quando supera i <b>150°</b>. È l'ultima colonna che spiega perché alcune boe — quelle dove si
torna indietro o si gira di 90° — il device non le conta come girate anche se la rotta le passa correttamente.</p>
<table>
 <tr><th>corso</th><th>nome</th><th>boe</th><th>percorso</th><th>lato</th><th>giro (min–max)</th><th>giro più stretto</th></tr>
 ${rows}
</table>
</body></html>
`;
}

// ----------------------------------------------------------------- main
async function main() {
    const only = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);
    let courses = await listCourses();
    if (only.length) courses = courses.filter(c => only.includes(c.id));
    courses.sort((a, b) => Number(a.id) - Number(b.id));
    if (!courses.length) throw new Error("nessun corso da disegnare");

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const entries = [];
    for (const c of courses) {
        const shape = shapeOfCourse(c);
        const route = compileShapeRoute(shape, ROUNDING_M);
        const rows = analyze(shape, route);
        const svg = renderCourse(c, shape, route, rows);
        const file = `corso-${String(c.id).padStart(3, "0")}-${c.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "corso"}.svg`;
        fs.writeFileSync(path.join(OUT_DIR, file), svg, "utf8");
        const total = route.slice(1).reduce((s, w, i) => s + Math.hypot(w.x - route[i].x, w.y - route[i].y), 0);
        entries.push({ course: c, file, rows, marks: (shape.marks || []).length, total });
        const bad = rows.filter(r => r.required && r.required !== r.passed).map(r => r.label).join(", ");
        const over = rows.filter(r => r.dist < 10 && r.passDist - r.dist > 3).map(r => `${r.label} a ${n1(r.dist)} m`).join(", ");
        console.log(`#${c.id} ${c.name}: ${rows.length} passaggi, ${bad ? "LATO SBAGLIATO a " + bad : "tutti dal lato giusto"}, giro ${rows.map(r => r.label + " " + n0(r.range) + "°").join(", ")}${over ? " | ci passa sopra: " + over : ""}`);
    }
    fs.writeFileSync(path.join(OUT_DIR, "index.html"), renderIndex(entries), "utf8");
    console.log(`\nscritti ${entries.length} disegni in ${OUT_DIR}`);
    console.log(`indice: ${path.join(OUT_DIR, "index.html")}`);
}

if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1); });

module.exports = { analyze, renderCourse, compileShapeRoute, shapeOfCourse, ROUNDING_M };
