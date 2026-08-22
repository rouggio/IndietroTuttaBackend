const express = require("express");
const PImage = require("pureimage");

const {
    MAP
} = require("../config");

const {
    getPoints,
    getLatestPoint
} = require("../store/gpsStore");

const {
    renderMap,
    imageToRGB565
} = require("../services/mapRenderer");

const router = express.Router();

// --------------------------------------------------
// GET /map/device.png
// --------------------------------------------------

router.get(
    "/map/device.png",
    async (req, res) => {

        const points =
            getPoints();

        const latest =
            getLatestPoint();

        if (!latest) {
            return res
                .status(404)
                .send("No GPS data available");
        }

        const width =
            parseInt(req.query.width) ||
            MAP.DEFAULT_WIDTH;

        const height =
            parseInt(req.query.height) ||
            MAP.DEFAULT_HEIGHT;

        const zoom =
            req.query.zoom !== undefined
                ? parseInt(req.query.zoom)
                : null;

        try {

            const result =
                await renderMap({
                    points,
                    latest,
                    width,
                    height,
                    zoom
                });

            res.set(
                "Content-Type",
                "image/png"
            );

            res.set(
                "Cache-Control",
                "no-cache, no-store, must-revalidate"
            );

            await PImage.encodePNGToStream(
                result.image,
                res
            );

        } catch (error) {

            console.error(
                "[Map] PNG render error:",
                error
            );

            res.status(500).send(
                "Failed to render map"
            );
        }
    }
);

// --------------------------------------------------
// GET /map/device.rgb565
// --------------------------------------------------

router.get(
    "/map/device.rgb565",
    async (req, res) => {

        const points =
            getPoints();

        const latest =
            getLatestPoint();

        if (!latest) {
            return res
                .status(404)
                .send("No GPS data available");
        }

        const width =
            parseInt(req.query.width) ||
            MAP.DEFAULT_WIDTH;

        const height =
            parseInt(req.query.height) ||
            MAP.DEFAULT_HEIGHT;

        const zoom =
            req.query.zoom !== undefined
                ? parseInt(req.query.zoom)
                : null;

        try {

            const result =
                await renderMap({
                    points,
                    latest,
                    width,
                    height,
                    zoom
                });

            const output =
                imageToRGB565(
                    result.image,
                    width,
                    height
                );

            res.set(
                "Content-Type",
                "application/octet-stream"
            );

            res.set(
                "Content-Length",
                output.length
            );

            res.set(
                "Cache-Control",
                "no-cache, no-store, must-revalidate"
            );

            console.log(
                `[Map] Sending ${output.length} bytes`
            );

            res.send(output);

        } catch (error) {

            console.error(
                "[Map] RGB565 render error:",
                error
            );

            res.status(500).send(
                "Failed to render RGB565 map"
            );
        }
    }
);

module.exports = router;