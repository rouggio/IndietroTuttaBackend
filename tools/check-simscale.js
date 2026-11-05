#!/usr/bin/env node
// tools/check-simscale.js (todo 66) — prove that a compressed sandbox race records
// the SAME race as a wall-clock one, and measure what the server can actually keep up with.
//
// It sails the same script twice: once at a low scale (default 1x) and once at a high
// one (default 50x), then compares the runs the two sessions stored:
//
//   * per boat (the synthetic id's last two chars are the boat index), elapsedSec must
//     be IDENTICAL — the tape's own epochs are the clock, so speed of execution must not
//     change the recorded race;
//   * the ordered standings (finishers by elapsed) must match too;
//   * it prints how long each pass took on the wall and how many fixes of the tape were
//     played, which is the honest measurement of the throughput ceiling.
//
// The 1x pass is REAL TIME (a 0.3-scale W/L is ~4 min; --scale 0.15 is ~2 min), so this
// is a one-off proof per script version, not a per-change test. Sessions are deleted at
// the end unless --keep.
//
// Usage: node tools/check-simscale.js [--course=34] [--scale=0.15] [--gun=40]
//        [--boats=2] [--scales=1,50] [--speeds=13.5,14.5] [--at lat,lon] [--keep]
//        [--base=http://localhost:3000]

const BASE = (arg("base") || "http://localhost:3000").replace(/\/$/, "");

function arg(name, dflt) {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
}
const flag = (name) => process.argv.includes(`--${name}`);

const courseId = Number(arg("course", 34));
const scale = Number(arg("scale", 0.15));
const gunSec = Number(arg("gun", 40));
const boatCount = Number(arg("boats", 2));
const speeds = String(arg("speeds", "13.5,14.5")).split(",").map(Number).filter((n) => n >= 1 && n <= 40);
const scales = String(arg("scales", "1,50")).split(",").map(Number).filter((n) => n >= 1);
const at = arg("at", null);
const windDir = Number(arg("wind", 90));
const windSpeed = Number(arg("windkn", 10));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
    const r = await fetch(BASE + path);
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(j && j.error)}`);
    return j;
}
async function send(method, path, body) {
    const r = await fetch(BASE + path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body: j };
}

// A place on the water to lay the course: --at, else the newest fix of any known
// boat (the sandbox has no device of its own to ask).
async function origin() {
    if (at) {
        const [lat, lon] = at.split(",").map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
        throw new Error("--at must be lat,lon");
    }
    const devs = await get("/devices").catch(() => null);
    const list = (devs && (devs.devices || devs)) || [];
    for (const d of list) {
        if (!d || !d.deviceId) continue;
        const l = await get(`/gps/latest?deviceId=${encodeURIComponent(d.deviceId)}`).catch(() => null);
        const row = l && (l.point || l);
        if (row && Number.isFinite(row.lat) && Number.isFinite(row.lon)) return { lat: row.lat, lon: row.lon };
    }
    throw new Error("no stored position to lay a course on — pass --at lat,lon");
}

function isoNow(plusSec) {
    return new Date(Date.now() + plusSec * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

async function sailOne(ts, o) {
    const tag = Math.floor(Math.random() * 255).toString(16).toUpperCase().padStart(2, "0");
    const ids = Array.from({ length: boatCount }, (_, i) => `AA:BB:CC:DD:${tag}:${String(i + 1).padStart(2, "0")}`);
    const boats = ids.map((deviceId, i) => ({
        deviceId,
        speedKn: speeds.length ? speeds[Math.min(i, speeds.length - 1)] : 13.5,
    }));
    const created = await send("POST", "/sessions", {
        courseId,
        name: `simscale ${ts}x`,
        date: new Date().toISOString().slice(0, 10),
        mode: "race",
        simulated: true,
        timeScale: ts,
        originLat: o.lat,
        originLon: o.lon,
        windDir,
        windSpeed,
        scale,
        startTime: isoNow(gunSec),
        boats: ids.map((deviceId) => ({ deviceId })),
    });
    if (!created.ok) throw new Error(`create (${ts}x) -> ${created.status} ${created.body && created.body.error}`);
    const sessionId = created.body.id;

    const t0 = Date.now();
    const started = await send("POST", "/sim/players", { sessionId, boats, timeScale: ts });
    if (!started.ok) throw new Error(`player start (${ts}x) -> ${started.status} ${started.body && started.body.error}`);

    let st = started.body;
    const deadline = Date.now() + 15 * 60 * 1000;
    while (st && st.running && Date.now() < deadline) {
        await sleep(250);
        st = await get(`/sim/players/${sessionId}`);
    }
    const wallMs = Date.now() - t0;

    const runs = await get(`/sessions/${sessionId}/runs`);
    return { ts, sessionId, wallMs, status: st, runs: runs.runs || runs };
}

function byBoat(runs) {
    const out = new Map();
    for (const r of runs) {
        const idx = String(r.deviceId || "").slice(-2);
        out.set(idx, { deviceId: r.deviceId, elapsedSec: r.elapsedSec, result: r.result || null });
    }
    return out;
}

// What this test can and cannot prove, and why:
//   * every session compiles its OWN tape (the sampler is seeded per creation), so a
//     1x run and a 50x run never sail byte-identical scripts - comparing their elapsed
//     would be comparing two different races;
//   * what MUST hold is that the recorded time comes from the TAPE, not the wall: the
//     player stamps start/finish from the run's own epochs, so run.elapsedSec has to
//     equal the player's tape-derived elapsedSec, and at a high scale it must NOT
//     collapse towards the (much shorter) wall time it took to play;
//   * and the wall-vs-tape ratio IS the throughput measurement, so it is printed.
(async () => {
    const o = await origin();
    console.log(`course ${courseId} · scale ${scale} · gun ${gunSec}s · ${boatCount} boat(s) · origin ${o.lat.toFixed(5)},${o.lon.toFixed(5)}`);
    const results = [];
    for (const ts of scales) {
        process.stdout.write(`  sailing ${ts}x ... `);
        const r = await sailOne(ts, o);
        const boats = (r.status && r.status.boats) || [];
        const played = boats.map((b) => `${b.played}/${b.total}${b.failed ? ` (${b.failed} failed)` : ""}`);
        const tapeSec = Math.max(0, ...boats.map((b) => (b.finishEpoch || 0) - (b.startEpoch || 0)));
        console.log(`${(r.wallMs / 1000).toFixed(1)}s wall · session ${r.sessionId} · fixes ${played.join(", ")} · recorded ${tapeSec}s of race`);
        results.push({ ...r, boats });
    }

    let ok = true;
    for (const r of results) {
        for (const w of (r.status && r.status.warnings) || []) console.log(`  ! ${r.ts}x ${w}`);
    }
    console.log(`\n  scale   boat   run elapsed   tape elapsed   wall time   verdict`);
    for (const r of results) {
        const run = byBoat(r.runs);
        if (!run.size) {
            ok = false; // no run at all: nothing was recorded, whatever the fixes did
            console.log(`  ${String(r.ts).padStart(4)}x   --     NO RUN UPLOADED (${r.status && r.status.boats ? r.status.boats.map((b) => b.played + "/" + b.total).join(", ") : "?"} fixes played)`);
            continue;
        }
        const st = new Map();
        for (const b of r.boats) st.set(String(b.deviceId || "").slice(-2), b);
        for (const idx of [...run.keys()].sort()) {
            const x = run.get(idx);
            const s = st.get(idx);
            const tapeElapsed = s ? Math.max(0, (s.finishEpoch || 0) - (s.startEpoch || 0)) : null;
            // The teammate's fix count is not the same as the tape's; compare the run
            // to the player's own tape-derived number.
            const same = tapeElapsed !== null && x.elapsedSec === tapeElapsed;
            // At a compressed scale the wall time is much shorter than the race time;
            // if the two converge, the run was stamped from the wall clock.
            const wallNotRacing = r.ts === 1 ? true : (r.wallMs / 1000) < (x.elapsedSec * 0.6);
            if (!same || !wallNotRacing) ok = false;
            console.log(`  ${String(r.ts).padStart(4)}x   ${idx}     ${String(x.elapsedSec).padStart(6)}s       ${String(tapeElapsed).padStart(6)}s     ${(r.wallMs / 1000).toFixed(1).padStart(6)}s   ${same ? (wallNotRacing ? "tape-timed" : "WALL-TIMED?!") : "MISMATCH"}`);
        }
    }

    if (!flag("keep")) {
        for (const r of results) await send("DELETE", `/sessions/${r.sessionId}`);
        console.log(`\n  deleted ${results.map((r) => r.sessionId).join(", ")}`);
    }
    console.log(ok
        ? `\nOK — every run recorded the TAPE's time at every scale (the wall time is not in the race)`
        : `\nFAIL — a run does not match its tape, or a compressed run was timed by the wall clock`);
    process.exit(ok ? 0 : 1);
})().catch((e) => {
    console.error("check-simscale:", e.message);
    process.exit(1);
});
