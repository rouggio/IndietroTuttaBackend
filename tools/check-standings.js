// The standings rules, proved without a database.
//
// todo 3's whole value is the ORDER of the table: corrected time (elapsed plus
// the SCP seconds the committee raised), a DSQ signal beating a run that says
// FINISHED, DNF/RET after the finishers, and a boat that has not uploaded yet
// still visible as RACING. A wrong table looks plausible — it is just a list of
// names in some order — so every rule gets a case here, and the same
// `rankRows()` is what `GET /sessions/:id/standings` calls.
//
// Usage: node tools/check-standings.js   (no server, no DB; exit 1 on failure)
const { rankRows } = require("../store/standings");

let failed = 0;
function t(name, cond, detail) {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
    if (!cond) failed++;
}

const boats = (...ids) => ids.map(deviceId => ({ deviceId }));
const run = (deviceId, elapsedSec, result = "FINISHED") => ({
    deviceId, elapsedSec, result, splits: elapsedSec ? [Math.round(elapsedSec / 3)] : [],
});
const sig = (kind, deviceId = null, detail = "") => ({ kind, deviceId, detail });
const order = rows => rows.map(r => r.deviceId).join(",");
const byId = (rows, id) => rows.find(r => r.deviceId === id) || {};

// --- plain finish order ------------------------------------------------------
{
    const rows = rankRows(boats("A", "B"), [run("A", 200), run("B", 210)], []);
    t("finishers rank by elapsed time", order(rows) === "A,B", order(rows));
    t("rank is 1..n only for finishers",
        byId(rows, "A").rank === 1 && byId(rows, "B").rank === 2);
    t("a clean finish has no penalty",
        byId(rows, "A").penaltySec === 0 && byId(rows, "A").correctedSec === 200);
}

// --- SCP moves a boat down the table, and can swap the lead ------------------
{
    const scp = [sig("SCP", "B", "15")];
    const rows = rankRows(boats("A", "B"), [run("A", 200), run("B", 210)], scp);
    t("SCP seconds are added to corrected time",
        byId(rows, "B").correctedSec === 225 && byId(rows, "B").penaltySec === 15);
    t("a penalty alone does not change the order", order(rows) === "A,B", order(rows));

    const heavy = [sig("SCP", "A", "40")];
    const swapped = rankRows(boats("A", "B"), [run("A", 200), run("B", 210)], heavy);
    t("enough penalty swaps the lead", order(swapped) === "B,A", order(swapped));
    t("B is rank 1 after the swap", byId(swapped, "B").rank === 1);
    t("elapsed time is kept as sailed", byId(swapped, "A").elapsedSec === 200);
}

// --- a committee DSQ beats a FINISHED run -----------------------------------
{
    const rows = rankRows(boats("A", "B"), [run("A", 200), run("B", 210)], [sig("DSQ", "A")]);
    t("a DSQ signal overrides the run's result", byId(rows, "A").result === "DSQ");
    t("a DSQ boat is unranked and last", byId(rows, "A").rank === null && order(rows) === "B,A", order(rows));
    t("the other boat keeps rank 1", byId(rows, "B").rank === 1);
}

// --- DNF / RET sit after the finishers, before the DSQ ----------------------
{
    const rows = rankRows(boats("A", "B", "C", "D"),
        [run("A", 200), run("B", null, "DNF"), run("C", null, "RET"), run("D", 190)],
        [sig("DSQ", "A")]);
    t("finishers first, then DNF/RET, then DSQ", order(rows) === "D,B,C,A", order(rows));
    t("DNF and RET are unranked", byId(rows, "B").rank === null && byId(rows, "C").rank === null);
    t("the only finisher is rank 1", byId(rows, "D").rank === 1);
}

// --- a boat that has not uploaded yet is still in its race ------------------
{
    const rows = rankRows(boats("A", "B"), [run("A", 200)], []);
    t("an upload-less boat shows as RACING", byId(rows, "B").result === "RACING");
    t("RACING is unranked and sits after the finishers",
        byId(rows, "B").rank === null && order(rows) === "A,B");
    t("an empty session yields an empty table", rankRows(boats(), [], []).length === 0);
}

// --- signals that are not about a single boat are ignored -------------------
{
    const rows = rankRows(boats("A"), [run("A", 200)], [sig("RECALL"), sig("SCP", "Z", "30")]);
    t("a fleet-wide signal and a stranger's SCP change nothing",
        byId(rows, "A").correctedSec === 200 && rows.length === 1);
}

console.log(`\n${failed ? failed + " FAILED" : "all standings rules hold"}`);
process.exit(failed ? 1 : 0);
