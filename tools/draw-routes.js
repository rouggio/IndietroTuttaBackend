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
const { shapeOfCourse, compileShapeRoute, resolveRoute, analyzeRoute } = require("../store/simShape");

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
// Tutto in coordinate vento: metri, x est, y sopravento. La lettura dei
// passaggi (lato, distanza, rotazione della boa) sta in store/simShape.js
// (`analyzeRoute`), condivisa con l'endpoint che serve l'editor.

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = v => Math.hypot(v.x, v.y);

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
        // Lato dichiarato + verso di giro: P = la barca passa a destra e gira CCW,
        // S = passa a sinistra e gira CW. Le boe di una porta non hanno lato.
        const turn = m.side === "P" ? " · P CCW" : m.side === "S" ? " · S CW" : "";
        const p = placer.label(`B${i + 1}${turn}`, x, y, Math.max(16, r + 13));
        markLayer += `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" font-size="13" font-weight="700" fill="#111827" text-anchor="${p.anchor}">B${i + 1}${turn}</text>`;
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

    // --- passaggi: i due traversi di ogni boa (entrata grigio, uscita verde),
    // il cerchietto dell'aggancio in entrata, il punto dell'uscita (verde =
    // lato dichiarato, rosso = lato sbagliato, grigio = non taglia mai).
    const TRAV_HL = 45; // mezza lunghezza di un traverso disegnato, in metri
    const travSeg = (c, u, colour, width, dash) => {
        const tx = -u.uy, ty = u.ux; // lungo la linea, perpendicolare all'asse
        return `<line x1="${mx(c.x - tx * TRAV_HL).toFixed(1)}" y1="${my(c.y - ty * TRAV_HL).toFixed(1)}" x2="${mx(c.x + tx * TRAV_HL).toFixed(1)}" y2="${my(c.y + ty * TRAV_HL).toFixed(1)}" stroke="${colour}" stroke-width="${width}" stroke-dasharray="${dash}"/>`;
    };
    let passLayer = "";
    for (const r of rows) {
        const c = r.centre;
        if (r.kind === "gate") {
            const p = r.point, px = mx(p.x), py = my(p.y);
            placer.hold(px - 9, py - 9, 18, 18);
            const col = r.ok ? "#7c3aed" : "#b91c1c";
            passLayer += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6" fill="#fff" stroke="${col}" stroke-width="2.5"/>`;
            const lp = placer.label(r.ok ? "attraversa" : "non attraversa", px, py, 20, 6.2);
            passLayer += `<text x="${lp.x.toFixed(1)}" y="${lp.y.toFixed(1)}" font-size="11.5" font-weight="600" fill="${col}" text-anchor="${lp.anchor}">${r.ok ? "attraversa" : "non attraversa"}</text>`;
            continue;
        }
        if (r.entry) passLayer += travSeg(c, r.entry, "#94a3b8", 1.6, "5 4");
        if (r.trav) passLayer += travSeg(c, r.trav, "#15803d", 2, "7 4");
        if (r.entryPoint) {
            const ex = mx(r.entryPoint.x), ey = my(r.entryPoint.y);
            passLayer += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4" fill="none" stroke="#64748b" stroke-width="1.6"/>`;
        }
        const p = r.point, px = mx(p.x), py = my(p.y);
        placer.hold(px - 9, py - 9, 18, 18);
        const col = !r.crossed ? "#94a3b8" : (r.ok ? "#15803d" : "#b91c1c");
        passLayer += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6" fill="#fff" stroke="${col}" stroke-width="2.5"/>`;
        const word = !r.crossed ? "non taglia" : (r.crossSide === "P" ? "destra (P)" : "sinistra (S)");
        const lp = placer.label(word, px, py, 20, 6.2);
        passLayer += `<text x="${lp.x.toFixed(1)}" y="${lp.y.toFixed(1)}" font-size="11.5" font-weight="600" fill="${col}" text-anchor="${lp.anchor}">${word}</text>`;
    }

    // --- tabella
    const t = tableFor(rows, course);
    return { svg: null, g, layers: { grid, ruler, wind, lineLayer, markLayer, routeLayer, passLayer }, table: t };
}

// ------------------------------------------------------------- tabella
function tableFor(rows, course) {
    const head = ["boa", "lato dichiarato", "taglio", "esito"];
    const body = rows.map(r => {
        if (r.kind === "gate") {
            return {
                cells: ["porta", "da attraversare", r.crossed ? "attraversa" : "non attraversa", r.crossed ? "buono" : "non taglia"],
                ok: r.ok, bad: r.crossed ? 0 : 2,
            };
        }
        const req = r.required === "P" ? "P · CCW" : r.required === "S" ? "S · CW" : "indifferente";
        const cut = !r.crossed ? "non taglia" : (r.crossSide === "P" ? "a destra (P)" : "a sinistra (S)");
        const bad = !r.crossed ? 2 : (r.ok ? 0 : 1);
        return {
            cells: [r.label, req, cut, !r.crossed ? "non taglia" : (r.ok ? "buono" : "lato sbagliato")],
            ok: r.ok, bad,
        };
    });
    return { head, body };
}

function tableSvg(table, x, y) {
    const cols = [70, 150, 190, 150];
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
            const colour = (i === 3 && row.bad === 1) ? "#b91c1c"
                : (i === 3 && row.bad === 2) ? "#b45309" : "#0f172a";
            const weight = (i === 3 && row.bad) ? "700" : "400";
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
    const noteH = 96;
    const W = Math.max(drawW, 760);
    const H = titleH + drawH + headerH + tableH + noteH;
    const offX = Math.round((W - drawW) / 2);
    const tbl = tableSvg(table, 40, titleH + drawH + headerH + 14);

    const bad = rows.some(r => !r.ok);
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
    <text x="0" y="0" font-size="12" fill="#64748b">Dall'alto si vede la forma del percorso così com'è salvata: la barca entra dal basso, la linea blu è partenza (e arrivo),</text>
    <text x="0" y="16" font-size="12" fill="#64748b">la linea arancione è la traccia della barca-simulatore, che gira ogni boa dal lato dichiarato (CCW per P, CW per S).</text>
    <text x="0" y="32" font-size="12" fill="#64748b">Per ogni boa sono disegnati i due traversi: quello d'entrata (grigio) e quello d'uscita (verde). Il passaggio vale quando la barca</text>
    <text x="0" y="48" font-size="12" fill="#64748b">taglia l'entrata allontanandosi dalla boa precedente (cerchietto grigio) e poi taglia l'uscita andando verso la prossima (punto</text>
    <text x="0" y="64" font-size="12" fill="#64748b">verde se dal lato dichiarato, rosso se dal lato sbagliato). Le porte si passano attraversando il segmento fra le due boe.</text>
  </g>
</svg>
`;
}

// -------------------------------------------------------------- indice
function renderIndex(entries) {
    const rows = entries.map(e => {
        const badMarks = e.rows.filter(r => !r.ok);
        const good = e.rows.length - badMarks.length;
        const worst = badMarks.length ? badMarks[0].label : null;
        return `<tr>
      <td>#${e.course.id}</td>
      <td><a href="${esc(e.file)}">${esc(e.course.name)}</a></td>
      <td>${e.marks}</td>
      <td>${n0(e.total)} m</td>
      <td class="${badMarks.length ? "bad" : "ok"}">${badMarks.length ? "lato sbagliato" : "lato giusto"}</td>
      <td>${good}/${e.rows.length} buoni${worst ? ` (primo: ${esc(worst)})` : ""}</td>
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
del costruttore di corsi) e la rotta che la barca-simulatore percorre: attesa dietro la linea, partenza, giro intorno a
ogni boa dal lato dichiarato (CCW per P, CW per S), arrivo e proseguimento oltre la linea. In acqua tutto questo viene solo
ruotato secondo il vento e spostato sul punto di partenza: la forma non cambia mai. Una figura per corso, il nome dice
quale è — l'id serve solo per ritrovarlo nell'elenco dei corsi.</p>
<p class="note">Per ogni boa sono disegnati i due traversi (entrata + uscita): il passaggio vale quando la barca taglia
l'entrata allontanandosi dalla boa precedente e poi taglia l'uscita andando verso la prossima, dal lato dichiarato.
Non ci sono distanze minime: conta da che parte si taglia, non quanto vicino si passa.</p>
<table>
 <tr><th>corso</th><th>nome</th><th>boe</th><th>percorso</th><th>lato</th><th>esito</th></tr>
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
        const rows = analyzeRoute(shape, route);
        const svg = renderCourse(c, shape, route, rows);
        const file = `corso-${String(c.id).padStart(3, "0")}-${c.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "corso"}.svg`;
        fs.writeFileSync(path.join(OUT_DIR, file), svg, "utf8");
        const total = route.slice(1).reduce((s, w, i) => s + Math.hypot(w.x - route[i].x, w.y - route[i].y), 0);
        entries.push({ course: c, file, rows, marks: (shape.marks || []).length, total });
        const bad = rows.filter(r => !r.ok).map(r => r.label).join(", ");
        const tagli = rows.map(r => {
            if (r.kind === "gate") return `${r.label} ${r.crossed ? "attraversa" : "NON attraversa"}`;
            return `${r.label} req${r.required || "-"} taglio ${!r.crossed ? "MAI" : "a " + (r.crossSide === "P" ? "destra" : "sinistra")} -> ${!r.crossed ? "NON TAGLIA" : (r.ok ? "buono" : "SBAGLIATO")}`;
        }).join(", ");
        console.log(`#${c.id} ${c.name}: ${rows.length} passaggi, ${bad ? "DA GUARDARE a " + bad : "tutti buoni"}: ${tagli}`);
    }
    fs.writeFileSync(path.join(OUT_DIR, "index.html"), renderIndex(entries), "utf8");
    console.log(`\nscritti ${entries.length} disegni in ${OUT_DIR}`);
    console.log(`indice: ${path.join(OUT_DIR, "index.html")}`);
}

if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1); });

module.exports = { analyzeRoute, renderCourse, compileShapeRoute, shapeOfCourse, ROUNDING_M };
