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
                boat TEXT
            )
        `);
        // Migrations for DBs created before these columns existed
        for (const col of ["firmware", "boat"]) {
            try {
                await c.execute(`ALTER TABLE devices ADD COLUMN ${col} TEXT`);
            } catch (e) {
                if (!/duplicate column/i.test(e.message || "")) throw e;
            }
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

        // Race program (Step 1A): course templates + day sessions.
        // Course marks are wind-frame offsets in meters (see store/courseStore.js).
        await c.execute(`
            CREATE TABLE IF NOT EXISTS courses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                owner TEXT,
                marks TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                is_template INTEGER NOT NULL DEFAULT 0,
                createdAt TEXT NOT NULL
            )
        `);
        // A session freezes a course onto a day: frozen template copy +
        // instantiation params + resolved absolute marks.
        await c.execute(`
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                courseId INTEGER,
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
        await c.execute(`
            CREATE TABLE IF NOT EXISTS session_boats (
                sessionId INTEGER NOT NULL,
                deviceId TEXT NOT NULL,
                startOffsetSec INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (sessionId, deviceId)
            )
        `);
        await c.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date)`);
        // Step 2+: optional start/finish line segments (wind-frame on courses,
        // resolved absolute on sessions). finishLine may be {"sameAs":"start"}.
        for (const table of ["courses", "sessions"]) {
            for (const col of ["startLine", "finishLine"]) {
                try {
                    await c.execute(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
                } catch (e) {
                    if (!/duplicate column/i.test(e.message || "")) throw e;
                }
            }
        }

        console.log("[DB] Turso tables ready");

        // No row cap: gps_points keeps every point.
        return c;
    })();

    return initPromise;
}

module.exports = { getClient, initDb };
