const express = require("express");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// CORS access for frontend
app.use(cors());

// serve public site
app.use(express.static(path.join(__dirname, "public")));

// Parse JSON bodies
app.use(express.json());

// Circular buffer (simple implementation)
const MAX_POINTS = 500;
const points = [];

/**
 * POST /gps
 *
 * Example body:
 * {
 *   "lat": 39.92526367,
 *   "lon": 9.656643667,
 *   "speed": 12.5,
 *   "course": 271.2,
 *   "altitude": 18,
 *   "sats": 9,
 *   "timestamp": "2026-07-16T08:15:00Z"
 * }
 */
app.post("/gps", (req, res) => {
    const deviceId = req.header("DeviceId");

    const {
        lat,
        lon,
        speed = null,
        course = null,
        altitude = null,
        sats = null,
        flagged = false,
        timestamp = new Date().toISOString()
    } = req.body;

    if (typeof lat !== "number" || typeof lon !== "number") {
        return res.status(400).json({
            error: "lat and lon must be numbers"
        });
    }

    if (typeof flagged !== "boolean") {
        return res.status(400).json({
            error: "flagged must be a boolean"
        });
    }

    points.push({
        lat,
        lon,
        speed,
        course,
        altitude,
        sats,
        flagged,
        timestamp,
        receivedAt: new Date().toISOString(),
        deviceId: deviceId
    });

    // Keep only last 100 entries
    if (points.length > MAX_POINTS) {
        points.shift();
    }

    res.json({
        status: "ok",
        stored: points.length
    });
});


/**
 * Returns all stored points
 */
app.get("/gps", (req, res) => {
    res.json(points);
});


/**
 * Returns latest point
 */
app.get("/gps/latest", (req, res) => {
    if (points.length === 0) {
        return res.status(404).json({
            error: "No GPS data available"
        });
    }

    res.json(points[points.length - 1]);
});


/**
 * Health check
 */
app.get("/health", (req, res) => {
    const deviceId = req.header("DeviceId");

    res.json({
        status: "ok",
        storedPoints: points.length,
        deviceId: deviceId || null
    });
});

// Map endpoints: compose tiles from tile.openstreetmap.org and draw track
const fetch = require('node-fetch');
const PImage = require('pureimage');

app.get('/map/device.png', async (req, res) => {
    if (points.length === 0) {
        return res.status(404).send('No GPS data available');
    }

    const latest = points[points.length - 1];
    const lat = latest.lat;
    const lon = latest.lon;

    const width = parseInt(req.query.width) || 320;
    const height = parseInt(req.query.height) || 240;
    let zoom = null;
    if (req.query.zoom) {
        zoom = parseInt(req.query.zoom);
    } else {
        // choose zoom so the screen width covers ~50 meters
        const desiredWidthMeters = 50.0;
        const latRadForZoom = (lat * Math.PI) / 180.0;
        const metersPerPixelTarget = desiredWidthMeters / width;
        const rawZoom = Math.log2(156543.03392 * Math.cos(latRadForZoom) / metersPerPixelTarget);
        zoom = Math.max(0, Math.min(19, Math.floor(rawZoom)));
    }

    function lon2xtile(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
    function lat2ytile(lat, z) { const latRad = lat * Math.PI / 180; return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, z); }

    const tileBase = 'https://tile.openstreetmap.org';
    try {
        const tileSize = 256;
        const centerX = lon2xtile(lon, zoom);
        const centerY = lat2ytile(lat, zoom);
        const tileX = Math.floor(centerX);
        const tileY = Math.floor(centerY);
        const pixelOffsetX = Math.floor((centerX - tileX) * tileSize);
        const pixelOffsetY = Math.floor((centerY - tileY) * tileSize);

        const bigN = 3;
        const bigW = bigN * tileSize;
        const bigH = bigN * tileSize;
        const bigImg = PImage.make(bigW, bigH);
        const bigCtx = bigImg.getContext('2d');
        bigCtx.fillStyle = '#e8edf0'; bigCtx.fillRect(0,0,bigW,bigH);

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const tx = tileX + dx;
                const ty = tileY + dy;
                const url = `${tileBase}/${zoom}/${tx}/${ty}.png`;
                try {
                    const tResp = await fetch(url);
                    if (tResp.ok) {
                        const tileImg = await PImage.decodePNGFromStream(tResp.body);
                        const drawX = (dx + 1) * tileSize;
                        const drawY = (dy + 1) * tileSize;
                        bigCtx.drawImage(tileImg, drawX, drawY);
                        continue;
                    }
                } catch (e) {
                    // ignore
                }
                const placeholder = PImage.make(tileSize, tileSize);
                const pCtx = placeholder.getContext('2d');
                pCtx.fillStyle = '#dfe6ea'; pCtx.fillRect(0,0,tileSize,tileSize);
                bigCtx.drawImage(placeholder, (dx+1)*tileSize, (dy+1)*tileSize);
            }
        }

        const centerPixelX = tileSize + pixelOffsetX;
        const centerPixelY = tileSize + pixelOffsetY;
        const cropX = Math.max(0, Math.floor(centerPixelX - width/2));
        const cropY = Math.max(0, Math.floor(centerPixelY - height/2));

        const img = PImage.make(width, height);
        const ctx = img.getContext('2d');
        ctx.drawImage(bigImg, -cropX, -cropY);

        // draw simple track
        const latRad = (lat * Math.PI)/180.0;
        const metersPerPixel = 156543.03392 * Math.cos(latRad) / Math.pow(2, zoom);
        const metersPerDegLat = 111132.92;
        const metersPerDegLon = 111319.49 * Math.cos(latRad);
        function toPixel(ptLat, ptLon) {
            const dLat = ptLat - lat; const dLon = ptLon - lon;
            const dxMeters = dLon * metersPerDegLon; const dyMeters = dLat * metersPerDegLat;
            const px = Math.floor(width/2 + dxMeters / metersPerPixel);
            const py = Math.floor(height/2 - dyMeters / metersPerPixel);
            return {x:px,y:py};
        }

        const maxDraw = Math.min(points.length, 200);
        if (maxDraw >= 2) {
            ctx.strokeStyle = '#1f77b4'; ctx.lineWidth = 2; let first=true;
            for (let i = points.length - maxDraw; i < points.length; i++) {
                const p = points[i]; const pt = toPixel(p.lat,p.lon);
                if (first) { ctx.beginPath(); ctx.moveTo(pt.x+0.5,pt.y+0.5); first=false; } else { ctx.lineTo(pt.x+0.5,pt.y+0.5); }
            }
            ctx.stroke();
            const start = points[points.length - maxDraw]; const sPt = toPixel(start.lat, start.lon);
            ctx.fillStyle = '#2ca02c'; ctx.fillRect(sPt.x-3, sPt.y-3, 6, 6);
        }

        const mx = Math.floor(width/2); const my = Math.floor(height/2);
        const mSize = Math.max(6, Math.floor(Math.min(width,height)*0.06));
        ctx.fillStyle = '#d62728'; ctx.fillRect(mx - Math.floor(mSize/2), my - Math.floor(mSize/2), mSize, mSize);

        res.set('Content-Type','image/png'); res.set('Cache-Control','no-cache, no-store, must-revalidate');
        await PImage.encodePNGToStream(img, res);
        return;
    } catch (err) {
        console.error('Tile compose error', err);
    }

    // final fallback: blank with red marker
    try {
        const img = PImage.make(width,height); const ctx = img.getContext('2d');
        ctx.fillStyle='#f0f0f0'; ctx.fillRect(0,0,width,height);
        const mx = Math.floor(width/2); const my = Math.floor(height/2);
        ctx.fillStyle='#d62728'; ctx.fillRect(mx-6,my-6,12,12);
        res.set('Content-Type','image/png'); res.set('Cache-Control','no-cache, no-store, must-revalidate');
        await PImage.encodePNGToStream(img,res);
        return;
    } catch (e) {
        console.error('Fallback generation failed',e);
        return res.status(502).send('Failed to fetch or render map');
    }
});

// RAW RGB565 endpoint (little-endian uint16 per pixel)
app.get('/map/device.rgb565', async (req, res) => {
    if (points.length === 0) {
        return res.status(404).send('No GPS data available');
    }

    const latest = points[points.length - 1];
    const lat = latest.lat;
    const lon = latest.lon;

    const width = parseInt(req.query.width) || 320;
    const height = parseInt(req.query.height) || 240;
    const zoom = parseInt(req.query.zoom) || 15;

    try {
        // For simplicity, render same offline map as fallback (grid + polyline)
        const img = PImage.make(width, height);
        const ctx = img.getContext('2d');

        // background
        ctx.fillStyle = '#e8edf0';
        ctx.fillRect(0, 0, width, height);

        // grid
        ctx.fillStyle = '#dfe6ea';
        const gridSize = 32;
        for (let x = 0; x < width; x += gridSize) ctx.fillRect(x, 0, 1, height);
        for (let y = 0; y < height; y += gridSize) ctx.fillRect(0, y, width, 1);

        // draw track as before
        const latRad = (lat * Math.PI) / 180.0;
        const metersPerPixel = 156543.03392 * Math.cos(latRad) / Math.pow(2, zoom);
        const metersPerDegLat = 111132.92; // approx
        const metersPerDegLon = 111319.49 * Math.cos(latRad);
        function toPixel(ptLat, ptLon) {
            const dLat = ptLat - lat;
            const dLon = ptLon - lon;
            const dxMeters = dLon * metersPerDegLon;
            const dyMeters = dLat * metersPerDegLat;
            const px = Math.floor(width / 2 + dxMeters / metersPerPixel);
            const py = Math.floor(height / 2 - dyMeters / metersPerPixel);
            return {x: px, y: py};
        }

        const maxDraw = Math.min(points.length, 200);
        if (maxDraw >= 2) {
            ctx.strokeStyle = '#1f77b4';
            ctx.lineWidth = 2;
            let first = true;
            for (let i = points.length - maxDraw; i < points.length; i++) {
                const p = points[i];
                const pt = toPixel(p.lat, p.lon);
                if (first) { ctx.beginPath(); ctx.moveTo(pt.x+0.5, pt.y+0.5); first=false; }
                else { ctx.lineTo(pt.x+0.5, pt.y+0.5); }
            }
            ctx.stroke();
        }

        // center marker
        const mx = Math.floor(width / 2);
        const my = Math.floor(height / 2);
        const mSize = Math.max(6, Math.floor(Math.min(width, height) * 0.06));
        ctx.fillStyle = '#d62728';
        ctx.fillRect(mx - Math.floor(mSize/2), my - Math.floor(mSize/2), mSize, mSize);

        // convert RGBA buffer to RGB565 little-endian
        const data = img.data; // Uint8Array
        const out = Buffer.alloc(width * height * 2);
        for (let i = 0; i < width * height; i++) {
            const r = data[i*4];
            const g = data[i*4 + 1];
            const b = data[i*4 + 2];
            const rgb565 = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
            out[i*2] = rgb565 & 0xFF; // LSB
            out[i*2 + 1] = (rgb565 >> 8) & 0xFF; // MSB
        }

        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Length', out.length);
        return res.send(out);

    } catch (err) {
        console.error('RGB565 render error', err);
        return res.status(500).send('Failed to render RGB565');
    }
});

app.listen(PORT, () => {
    console.log(`GPS server listening on port ${PORT}`);
});
