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
                simulated INTEGER NOT NULL DEFAULT 0,
                timestamp TEXT,
                receivedAt TEXT NOT NULL
            )
        `);
        // Mock-GPS uploads are tagged simulated=1 (shown on the map like
        // normal points; filterable via the flag)
        try {
            await c.execute(`ALTER TABLE gps_points ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0`);
        } catch (e) {
            if (!/duplicate column/i.test(e.message || "")) throw e;
        }

        await c.execute(`CREATE INDEX IF NOT EXISTS idx_gps_device ON gps_points(deviceId)`);
        await c.execute(`CREATE INDEX IF NOT EXISTS idx_gps_timestamp ON gps_points(timestamp)`);

        // Waypoints are gone (device + web): drop the leftover flag index
        // and columns. Best-effort — if the engine refuses DROP COLUMN the
        // old columns simply stay unused (nothing reads or writes them).
        await c.execute(`DROP INDEX IF EXISTS idx_gps_flagged`);
        for (const col of ["flagged", "uid"]) {
            try {
                await c.execute(`ALTER TABLE gps_points DROP COLUMN ${col}`);
            } catch (e) {
                // ignore: column already gone, or engine without DROP COLUMN
            }
        }

        // Race program: course library (shape only) + day sessions.
        // Course marks are wind-frame offsets in meters (see store/courseStore.js).
        // 2026-10-09: the concept is called "course" everywhere. This table has
        // been renamed twice (courses -> templates -> courses); both migrations
        // are kept so any historical DB lands on the current name. Tolerant to
        // fresh DBs (both fail with "no such table" and are ignored).
        try {
            await c.execute(`ALTER TABLE templates RENAME TO courses`);
        } catch (e) {
            if (!/no such table/i.test(e.message || "")) throw e;
        }
        await c.execute(`
            CREATE TABLE IF NOT EXISTS courses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                owner TEXT,
                marks TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                createdAt TEXT NOT NULL
            )
        `);
        // Built-in shapes seeded into the same table (builtinKey set). They are
        // read-only: the UI can only copy them. NULL for user courses.
        try {
            await c.execute(`ALTER TABLE courses ADD COLUMN builtinKey TEXT`);
        } catch (e) {
            if (!/duplicate column/i.test(e.message || "")) throw e;
        }
        // A session encapsulates a course frozen onto a day: snapshot copy +
        // instantiation params + resolved absolute marks. courseId is nullable
        // provenance ("cloned from", may dangle) — never read through.
        await c.execute(`
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                courseId INTEGER,
                courseShapeVersion INTEGER,
                name TEXT,
                date TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'practice',
                originLat REAL NOT NULL,
                originLon REAL NOT NULL,
                windDir REAL NOT NULL,
                windSpeed REAL,
                scale REAL NOT NULL DEFAULT 1,
                startTime TEXT,
                status TEXT NOT NULL DEFAULT 'scheduled',
                courseVersion INTEGER NOT NULL DEFAULT 1,
                courseSnapshot TEXT NOT NULL,
                marks TEXT NOT NULL,
                createdAt TEXT NOT NULL
            )
        `);
        // Migrate pre-rename schemas (best-effort, ignore when absent).
        // courseId/courseShapeVersion/courseSnapshot were templateId/
        // templateVersion/templateSnapshot before 2026-10-09. NOTE: sessions'
        // own courseVersion (geometry revision, pushed to devices) is a
        // DIFFERENT counter and is never renamed.
        for (const [from, to] of [
            ["templateId", "courseId"],
            ["templateVersion", "courseShapeVersion"],
            ["templateSnapshot", "courseSnapshot"],
        ]) {
            try {
                await c.execute(`ALTER TABLE sessions RENAME COLUMN ${from} TO ${to}`);
            } catch (e) {
                if (!/no such column/i.test(e.message || "")) throw e;
            }
        }
        for (const col of ["courseShapeVersion"]) {
            try {
                await c.execute(`ALTER TABLE sessions ADD COLUMN ${col} INTEGER`);
            } catch (e) {
                if (!/duplicate column/i.test(e.message || "")) throw e;
            }
        }
        try {
            await c.execute(`ALTER TABLE sessions ADD COLUMN windSpeed REAL`);
        } catch (e) {
            if (!/duplicate column/i.test(e.message || "")) throw e;
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
        // Course description (editable in builder, shown in course list).
        try {
            await c.execute(`ALTER TABLE courses ADD COLUMN desc TEXT`);
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

        // Built-in course shapes live in the `courses` table (builtinKey set),
        // read-only — the UI can only copy them. Seeded once, idempotently.
        try {
            const { seedBuiltinCourses } = require("./courseStore");
            await seedBuiltinCourses();
        } catch (e) {
            console.warn("[DB] builtin course seed skipped:", e.message || e);
        }

        console.log("[DB] Turso tables ready");

        // No row cap: gps_points keeps every point.
        return c;
    })();

    return initPromise;
}

module.exports = { getClient, initDb };
