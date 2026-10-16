// Compile-check every course's scripted route against the device rules.
// Creates a boat-less session per course (geometry only, no auto-sim),
// runs check-route.js on each, deletes the sessions afterwards —
// side-effect free. Usage: node tools/check-matrix.js [id,...]
// Default: the five built-ins 34-38. Customs pass their ids explicitly.
const { execFileSync } = require("child_process");

const BASE = process.env.BACKEND || "http://localhost:3000";
const ids = (process.argv[2] || "34,35,36,37,38").split(",").map(Number).filter(Boolean);

async function json(path, body) {
    const r = await fetch(`${BASE}${path}`, body ? {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    } : undefined);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${JSON.stringify(j)}`);
    return j;
}

(async () => {
    const made = [];
    let fails = 0;
    for (const courseId of ids) {
        const s = await json("/sessions", {
            courseId,
            date: new Date().toISOString().slice(0, 10),
            mode: "practice",
            name: `CHECK ${courseId}`,
            originLat: 44.0, originLon: 9.0,
            windDir: 45, scale: 1,
            startTime: new Date(Date.now() + 60000).toISOString(),
        });
        made.push(s.id);
        console.log(`--- course ${courseId} -> session ${s.id} ---`);
        try {
            execFileSync(process.execPath, ["tools/check-route.js", String(s.id)], { stdio: "inherit" });
        } catch {
            fails++;
        }
    }
    for (const id of made) {
        try { await fetch(`${BASE}/sessions/${id}`, { method: "DELETE" }); } catch {}
    }
    console.log(fails ? `\n${fails} COURSE(S) FAILING` : "\nmatrix green");
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
