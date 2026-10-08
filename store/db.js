require("dotenv").config();

const { createClient } = require("@libsql/client");

let client = null;
let initPromise = null;

function getClient() {
    if (client) return client;

    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url) {
        return null;
    }

    client = createClient({ url, authToken });
    return client;
}

async function initDb() {
    if (initPromise) return initPromise;

    const c = getClient();
    if (!c) {
        console.log("[DB] No TURSO_DATABASE_URL - running in-memory mode");
        return null;
    }

    initPromise = (async () => {
        // Test connection first - will throw if token is invalid/truncated
        try {
            await c.execute("SELECT 1");
        } catch (e) {
            console.error("[DB] Connection test failed:", e.message);
            throw e;
        }

        await c.execute(`
            CREATE TABLE IF NOT EXISTS devices (
                deviceId TEXT PRIMARY KEY,
                username TEXT,
                firstSeen TEXT NOT NULL,
                lastSeen TEXT NOT NULL,
                firmware TEXT,
                boat TEXT,
                ip TEXT,
                mock INTEGER NOT NULL DEFAULT 0
            )
        `);
        // Migrations for DBs created before these columns existed
        for (const col of ["firmware", "boat", "ip"]) {
            try {
                await c.execute(`ALTER TABLE devices ADD COLUMN ${col} TEXT`);
            } catch (e) {
                if (!/duplicate column/i.test(e.message || "")) throw e;
            }
        }
        // mock is INTEGER (truthy 1/0); older DBs that got it as TEXT via
        // the loop above still work — SQLite is dynamically typed and all
        // reads go through truthiness checks.
        try {
            await c.execute(`ALTER TABLE devices ADD COLUMN mock INTEGER NOT NULL DEFAULT 0`);
        } catch (e) {
            if (!/duplicate column/i.test(e.message || "")) throw e;
        }

        await c.execute(`
            CREATE TABLE IF NOT EXISTS gps_points (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                deviceId TEXT,
                username TEXT,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                speed REAL,
                course REAL,
                altitude REAL,
                sats INTEGER,
                flagged INTEGER NOT NULL DEFAULT 0,
                uid TEXT,
                timestamp TEXT,
                receivedAt TEXT NOT NULL
            )
        `);
        // Migration for DBs created before the uid column existed
        try {
            await c.execute(`ALTER TABLE gps_points ADD COLUMN uid TEXT`);
        } catch (e) {
            if (!/duplicate column/i.test(e.message || "")) throw e;
        }

        await c.execute(`CREATE INDEX IF NOT EXISTS idx_gps_device ON gps_points(deviceId)`);
        await c.execute(`CREATE INDEX IF NOT EXISTS idx_gps_flagged ON gps_points(flagged)`);
        await c.execute(`CREATE INDEX IF NOT EXISTS idx_gps_timestamp ON gps_points(timestamp)`);

        // Race program: template library (shape only) + day sessions.
        // Template marks are wind-frame offsets in meters (see store/templateStore.js).
        // One-time rename from the old "courses" name; tolerant to fresh DBs.
        try {
            await c.execute(`ALTER TABLE courses RENAME TO templates`);
        } catch (e) {
            if (!/no such table/i.test(e.message || "")) throw e;
        }
        await c.execute(`
            CREATE TABLE IF NOT EXISTS templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                owner TEXT,
                marks TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                is_template INTEGER NOT NULL DEFAULT 1,
                createdAt TEXT NOT NULL
            )
        `);
        // A session encapsulates a template frozen onto a day: snapshot copy +
        // instantiation params + resolved absolute marks. templateId is nullable
        // provenance ("cloned from", may dangle) — never read through.
        await c.execute(`
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                templateId INTEGER,
                templateVersion INTEGER,
                name TEXT,
                date TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'practice',
                originLat REAL NOT NULL,
                originLon REAL NOT NULL,
                windDir REAL NOT NULL,
                scale REAL NOT NULL DEFAULT 1,
                startTime TEXT,
                status TEXT NOT NULL DEFAULT 'scheduled',
                courseVersion INTEGER NOT NULL DEFAULT 1,
                templateSnapshot TEXT NOT NULL,
                marks TEXT NOT NULL,
                createdAt TEXT NOT NULL
            )
        `);
        // Migrate pre-rename schemas (best-effort, ignore when absent).
        try {
            await c.execute(`ALTER TABLE sessions RENAME COLUMN courseId TO templateId`);
        } catch (e) {
            if (!/no such column/i.test(e.message || "")) throw e;
        }
        for (const col of ["templateVersion"]) {
            try {
                await c.execute(`ALTER TABLE sessions ADD COLUMN ${col} INTEGER`);
            } catch (e) {
                if (!/duplicate column/i.test(e.message || "")) throw e;
            }
        }
        await c.execute(`
            CREATE TABLE IF NOT EXISTS session_boats (
                sessionId INTEGER NOT NULL,
                deviceId TEXT NOT NULL,
                startOffsetSec INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (sessionId, deviceId)
            )
        `);
        await c.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date)`);
        // Step 2+: optional start/finish line segments (wind-frame on templates,
        // resolved absolute on sessions). finishLine may be {"sameAs":"start"}.
        for (const table of ["templates", "sessions"]) {
            for (const col of ["startLine", "finishLine"]) {
                try {
                    await c.execute(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
                } catch (e) {
                    if (!/duplicate column/i.test(e.message || "")) throw e;
                }
            }
        }
        // Template description (editable in builder, shown in template list).
        try {
            await c.execute(`ALTER TABLE templates ADD COLUMN desc TEXT`);
        } catch (e) {
            if (!/duplicate column/i.test(e.message || "")) throw e;
        }
        // Step 5/6: device run uploads (one row per device per session,
        // re-upload replaces). Step 7: committee signals for devices.
        await c.execute(`
            CREATE TABLE IF NOT EXISTS runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sessionId INTEGER NOT NULL,
                deviceId TEXT NOT NULL,
                startEpoch INTEGER NOT NULL,
                finishEpoch INTEGER,
                elapsedSec INTEGER,
                splits TEXT NOT NULL DEFAULT '[]',
                events TEXT NOT NULL DEFAULT '[]',
                result TEXT NOT NULL DEFAULT 'FINISHED',
                createdAt TEXT NOT NULL,
                UNIQUE (sessionId, deviceId)
            )
        `);
        await c.execute(`CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(sessionId)`);
        await c.execute(`
            CREATE TABLE IF NOT EXISTS signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sessionId INTEGER NOT NULL,
                kind TEXT NOT NULL,
                deviceId TEXT,
                detail TEXT NOT NULL DEFAULT '',
                createdAt TEXT NOT NULL
            )
        `);
        await c.execute(`CREATE INDEX IF NOT EXISTS idx_signals_session ON signals(sessionId)`);

        console.log("[DB] Turso tables ready");

        // No row cap: gps_points keeps every point.
        return c;
    })();

    return initPromise;
}

module.exports = { getClient, initDb };
