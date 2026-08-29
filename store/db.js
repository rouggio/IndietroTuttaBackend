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
                lastSeen TEXT NOT NULL
            )
        `);

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
                timestamp TEXT,
                receivedAt TEXT NOT NULL
            )
        `);

        await c.execute(`CREATE INDEX IF NOT EXISTS idx_gps_device ON gps_points(deviceId)`);
        await c.execute(`CREATE INDEX IF NOT EXISTS idx_gps_flagged ON gps_points(flagged)`);
        await c.execute(`CREATE INDEX IF NOT EXISTS idx_gps_timestamp ON gps_points(timestamp)`);

        console.log("[DB] Turso tables ready");

        // Enforce MAX_POINTS via trigger or app-level trim - keep app trim for now
        return c;
    })();

    return initPromise;
}

module.exports = { getClient, initDb };
