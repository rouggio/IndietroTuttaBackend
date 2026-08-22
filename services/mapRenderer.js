const fetch = require("node-fetch");
const PImage = require("pureimage");

const {
    MAP
} = require("../config");

// --------------------------------------------------
// Geographic helpers
// --------------------------------------------------

function lon2xtile(lon, zoom) {
    return (
        (lon + 180) /
        360 *
        Math.pow(2, zoom)
    );
}

function lat2ytile(lat, zoom) {

    const latRad =
        lat * Math.PI / 180;

    return (
        (
            1 -
            Math.log(
                Math.tan(latRad) +
                1 / Math.cos(latRad)
            ) / Math.PI
        ) / 2
    ) * Math.pow(2, zoom);
}

// --------------------------------------------------
// Calculate zoom
// --------------------------------------------------

function calculateZoom(
    lat,
    width,
    desiredWidthMeters
) {

    const latRad =
        lat * Math.PI / 180;

    const metersPerPixelTarget =
        desiredWidthMeters / width;

    const rawZoom =
        Math.log2(
            156543.03392 *
            Math.cos(latRad) /
            metersPerPixelTarget
        );

    return Math.max(
        MAP.MIN_ZOOM,
        Math.min(
            MAP.MAX_ZOOM,
            Math.floor(rawZoom)
        )
    );
}

// --------------------------------------------------
// Download and compose OSM tiles
// --------------------------------------------------

async function composeTiles(
    lat,
    lon,
    zoom
) {

    const tileSize = MAP.TILE_SIZE;

    const centerX =
        lon2xtile(lon, zoom);

    const centerY =
        lat2ytile(lat, zoom);

    const tileX =
        Math.floor(centerX);

    const tileY =
        Math.floor(centerY);

    const pixelOffsetX =
        Math.floor(
            (centerX - tileX) *
            tileSize
        );

    const pixelOffsetY =
        Math.floor(
            (centerY - tileY) *
            tileSize
        );

    const bigN = 3;

    const bigW =
        bigN * tileSize;

    const bigH =
        bigN * tileSize;

    const bigImg =
        PImage.make(bigW, bigH);

    const bigCtx =
        bigImg.getContext("2d");

    // --------------------------------------------------
    // Fallback background
    // --------------------------------------------------

    bigCtx.fillStyle = "#e8edf0";

    bigCtx.fillRect(
        0,
        0,
        bigW,
        bigH
    );

    const tilesPerSide =
        Math.pow(2, zoom);

    // --------------------------------------------------
    // Download 3x3 tiles
    // --------------------------------------------------

    for (let dx = -1; dx <= 1; dx++) {

        for (let dy = -1; dy <= 1; dy++) {

            let tx = tileX + dx;

            const ty =
                tileY + dy;

            // Wrap longitude
            tx =
                (
                    (tx % tilesPerSide) +
                    tilesPerSide
                ) % tilesPerSide;

            // Latitude cannot wrap
            if (
                ty < 0 ||
                ty >= tilesPerSide
            ) {
                continue;
            }

            const url =
                `${MAP.TILE_URL}/${zoom}/${tx}/${ty}.png`;

            const drawX =
                (dx + 1) * tileSize;

            const drawY =
                (dy + 1) * tileSize;

            try {

                const response =
                    await fetch(url, {
                        headers: {
                            "User-Agent":
                                MAP.USER_AGENT
                        }
                    });

                if (!response.ok) {

                    console.error(
                        `[Map] Tile HTTP ${response.status}: ` +
                        `${zoom}/${tx}/${ty}`
                    );

                    continue;
                }

                const tileImg =
                    await PImage.decodePNGFromStream(
                        response.body
                    );

                bigCtx.drawImage(
                    tileImg,
                    drawX,
                    drawY
                );

            } catch (error) {

                console.error(
                    `[Map] Tile failed ${zoom}/${tx}/${ty}:`,
                    error
                );
            }
        }
    }

    return {
        bigImg,
        bigW,
        bigH,
        centerPixelX:
            tileSize + pixelOffsetX,
        centerPixelY:
            tileSize + pixelOffsetY
    };
}

// --------------------------------------------------
// Crop map around current position
// --------------------------------------------------

function cropMap(
    bigImg,
    bigW,
    bigH,
    centerPixelX,
    centerPixelY,
    width,
    height
) {

    let cropX =
        Math.floor(
            centerPixelX -
            width / 2
        );

    let cropY =
        Math.floor(
            centerPixelY -
            height / 2
        );

    cropX =
        Math.max(
            0,
            Math.min(
                cropX,
                bigW - width
            )
        );

    cropY =
        Math.max(
            0,
            Math.min(
                cropY,
                bigH - height
            )
        );

    const img =
        PImage.make(
            width,
            height
        );

    const ctx =
        img.getContext("2d");

    ctx.drawImage(
        bigImg,
        -cropX,
        -cropY
    );

    return {
        img,
        ctx
    };
}

// --------------------------------------------------
// Draw GPS track
// --------------------------------------------------

function drawTrack(
    ctx,
    points,
    lat,
    lon,
    zoom,
    width,
    height
) {

    const latRad =
        lat * Math.PI / 180;

    const metersPerPixel =
        156543.03392 *
        Math.cos(latRad) /
        Math.pow(2, zoom);

    const metersPerDegLat =
        111132.92;

    const metersPerDegLon =
        111319.49 *
        Math.cos(latRad);

    function toPixel(
        pointLat,
        pointLon
    ) {

        const dLat =
            pointLat - lat;

        const dLon =
            pointLon - lon;

        const dxMeters =
            dLon * metersPerDegLon;

        const dyMeters =
            dLat * metersPerDegLat;

        return {
            x: Math.floor(
                width / 2 +
                dxMeters / metersPerPixel
            ),

            y: Math.floor(
                height / 2 -
                dyMeters / metersPerPixel
            )
        };
    }

    const maxDraw =
        Math.min(
            points.length,
            MAP.MAX_TRACK_POINTS
        );

    if (maxDraw < 2) {
        return;
    }

    ctx.strokeStyle = "#1f77b4";
    ctx.lineWidth = 3;

    let lastX = null;
    let lastY = null;
    let started = false;

    for (
        let i = points.length - maxDraw;
        i < points.length;
        i++
    ) {

        const point =
            points[i];

        const pixel =
            toPixel(
                point.lat,
                point.lon
            );

        // Ignore points outside screen
        if (
            pixel.x < -10 ||
            pixel.x > width + 10 ||
            pixel.y < -10 ||
            pixel.y > height + 10
        ) {
            continue;
        }

        // Ignore duplicate pixels
        if (
            lastX !== null &&
            pixel.x === lastX &&
            pixel.y === lastY
        ) {
            continue;
        }

        if (!started) {

            ctx.beginPath();

            ctx.moveTo(
                pixel.x + 0.5,
                pixel.y + 0.5
            );

            started = true;

        } else {

            ctx.lineTo(
                pixel.x + 0.5,
                pixel.y + 0.5
            );
        }

        lastX = pixel.x;
        lastY = pixel.y;
    }

    if (started) {
        ctx.stroke();
    }
}

// --------------------------------------------------
// Draw current GPS marker
// --------------------------------------------------

function drawMarker(
    ctx,
    width,
    height
) {

    const mx =
        Math.floor(width / 2);

    const my =
        Math.floor(height / 2);

    const markerSize =
        Math.max(
            8,
            Math.floor(
                Math.min(
                    width,
                    height
                ) * 0.06
            )
        );

    // White outline
    ctx.fillStyle = "#ffffff";

    ctx.fillRect(
        mx -
            Math.floor(markerSize / 2) -
            2,

        my -
            Math.floor(markerSize / 2) -
            2,

        markerSize + 4,
        markerSize + 4
    );

    // Red center
    ctx.fillStyle = "#d62728";

    ctx.fillRect(
        mx -
            Math.floor(markerSize / 2),

        my -
            Math.floor(markerSize / 2),

        markerSize,
        markerSize
    );
}

// --------------------------------------------------
// Render complete map
// --------------------------------------------------

async function renderMap({
    points,
    latest,
    width,
    height,
    zoom
}) {

    const lat =
        latest.lat;

    const lon =
        latest.lon;

    if (zoom === null || zoom === undefined) {

        zoom =
            calculateZoom(
                lat,
                width,
                MAP.RGB565_WIDTH_METERS
            );
    }

    const composed =
        await composeTiles(
            lat,
            lon,
            zoom
        );

    const cropped =
        cropMap(
            composed.bigImg,
            composed.bigW,
            composed.bigH,
            composed.centerPixelX,
            composed.centerPixelY,
            width,
            height
        );

    drawTrack(
        cropped.ctx,
        points,
        lat,
        lon,
        zoom,
        width,
        height
    );

    drawMarker(
        cropped.ctx,
        width,
        height
    );

    return {
        image: cropped.img,
        width,
        height,
        zoom
    };
}

// --------------------------------------------------
// Convert PureImage RGBA -> RGB565
// --------------------------------------------------

function imageToRGB565(img, width, height) {

    const data =
        img.data;

    const output =
        Buffer.alloc(
            width *
            height *
            2
        );

    for (
        let i = 0;
        i < width * height;
        i++
    ) {

        const r =
            data[i * 4];

        const g =
            data[i * 4 + 1];

        const b =
            data[i * 4 + 2];

        const rgb565 =
            ((r >> 3) << 11) |
            ((g >> 2) << 5) |
            (b >> 3);

        // Little endian
        output[i * 2] =
            rgb565 & 0xff;

        output[i * 2 + 1] =
            (rgb565 >> 8) & 0xff;
    }

    return output;
}

module.exports = {
    renderMap,
    imageToRGB565
};