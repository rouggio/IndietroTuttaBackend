// Stale-live-session predicate (todo 67) - the rule without a database.
//
// `staleLive(session, seenByDevice, now)` decides whether a session that has
// passed its gun and not finished is nonetheless OVER. It is pure on purpose:
// the cases that matter are mostly about time and absence, which is exactly
// what is painful to arrange against a live Turso DB (wait six hours, unplug a
// boat, rewind a clock). Here they are all data.
//
// Run: node tools/check-stale.js   (or: npm run stale)
const assert = require("assert");
const {
    staleLive,
    STALE_LIVE_MS,
    DEVICE_GONE_MS,
} = require("../store/sessionStore");

const H = 60 * 60 * 1000;
const M = 60 * 1000;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const iso = ms => new Date(ms).toISOString();

// A one-boat session whose gun was `gunAgoMs` ago, with that boat's device last
// heard `seenAgoMs` ago (null = never heard: `ensureDevice` writes "").
function fleet({ gunAgoMs, seenAgoMs = [null] }) {
    const seen = new Map();
    const boats = seenAgoMs.map((ago, i) => {
        const deviceId = `AA:BB:CC:DD:EE:0${i + 1}`;
        seen.set(deviceId, ago == null ? "" : iso(NOW - ago));
        return { deviceId };
    });
    return {
        session: { startTime: iso(NOW - gunAgoMs), boats },
        seen,
    };
}

const cases = [];
function check(name, expected, input) {
    cases.push({ name, expected, input });
}

// --- age -----------------------------------------------------------------
check("gun 7h ago, device still beating -> stale (age wins)",
    true, fleet({ gunAgoMs: 7 * H, seenAgoMs: [0] }));
check("gun 7h ago, nothing ever heard -> stale",
    true, fleet({ gunAgoMs: 7 * H, seenAgoMs: [null] }));
check("gun 1h ago, device beating now -> live",
    false, fleet({ gunAgoMs: 1 * H, seenAgoMs: [0] }));
check("gun 5h59 ago, device quiet 20min -> stale without reaching the age cap",
    true, fleet({ gunAgoMs: 5 * H + 59 * M, seenAgoMs: [20 * M] }));

// --- the field has left ---------------------------------------------------
check("gun 1h ago, seen 10min ago (inside the grace) -> live",
    false, fleet({ gunAgoMs: 1 * H, seenAgoMs: [10 * M] }));
check("gun 1h ago, seen 40min ago (after the gun, now silent) -> stale",
    true, fleet({ gunAgoMs: 1 * H, seenAgoMs: [40 * M] }));
check("gun 1h ago, never heard since the gun (fleet never arrived) -> live",
    false, fleet({ gunAgoMs: 1 * H, seenAgoMs: [null] }));
check("gun 1h ago, two boats, one still beating -> live",
    false, fleet({ gunAgoMs: 1 * H, seenAgoMs: [45 * M, 0] }));
check("gun 1h ago, two boats, both gone -> stale",
    true, fleet({ gunAgoMs: 1 * H, seenAgoMs: [45 * M, 40 * M] }));

// --- boundaries and degenerate input --------------------------------------
check("gun exactly STALE_LIVE_MS ago -> still live",
    false, fleet({ gunAgoMs: STALE_LIVE_MS, seenAgoMs: [0] }));
check("gun STALE_LIVE_MS + 1s ago -> stale",
    true, fleet({ gunAgoMs: STALE_LIVE_MS + 1000, seenAgoMs: [0] }));
check("gun DEVICE_GONE_MS ago, seen exactly DEVICE_GONE_MS ago -> live (grace boundary)",
    false, fleet({ gunAgoMs: DEVICE_GONE_MS, seenAgoMs: [DEVICE_GONE_MS] }));
check("seen DEVICE_GONE_MS + 1s ago, after the gun -> stale",
    true, fleet({ gunAgoMs: 1 * H, seenAgoMs: [DEVICE_GONE_MS + 1000] }));
check("gun in the future -> not live, not stale",
    false, fleet({ gunAgoMs: -1 * H, seenAgoMs: [0] }));
check("no startTime -> false",
    false, { session: { startTime: null, boats: [] }, seen: new Map() });
check("no boats, gun 1h ago -> false (nothing could have left)",
    false, fleet({ gunAgoMs: 1 * H, seenAgoMs: [] }));
check("no boats, gun 7h ago -> stale (age)",
    true, fleet({ gunAgoMs: 7 * H, seenAgoMs: [] }));
check("no boats map at all -> false",
    false, { session: { startTime: iso(NOW - H), boats: [{ deviceId: "X" }] }, seen: null });

let failed = 0;
for (const c of cases) {
    let got;
    try {
        got = staleLive(c.input.session, c.input.seen, NOW);
    } catch (e) {
        got = `threw: ${e.message}`;
    }
    if (got === c.expected) {
        console.log(`ok   ${c.name}`);
    } else {
        failed++;
        console.log(`FAIL ${c.name} -> got ${got}, wanted ${c.expected}`);
    }
}

try {
    // The rule must not fire for a session that has not reached its gun, even
    // with a fleet that has been silent for days.
    assert.strictEqual(
        staleLive({ startTime: iso(NOW + H), boats: [{ deviceId: "X" }] }, new Map([["X", ""]]), NOW),
        false
    );
    console.log("ok   scheduled session stays scheduled");
} catch (e) {
    failed++;
    console.log(`FAIL scheduled session -> ${e.message}`);
}

console.log(`\n${cases.length + 1} case(s), ${failed} failure(s)`);
process.exit(failed ? 1 : 0);
