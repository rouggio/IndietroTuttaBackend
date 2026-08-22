module.exports = {
    PORT: process.env.PORT || 3000,

    GPS: {
        MAX_POINTS: 500
    },

    MAP: {
        TILE_SIZE: 256,

        DEFAULT_WIDTH: 320,
        DEFAULT_HEIGHT: 240,

        MIN_ZOOM: 0,
        MAX_ZOOM: 19,

        // Used when /map/device.png has no zoom parameter.
        PNG_WIDTH_METERS: 50,

        // Used when /map/device.rgb565 has no zoom parameter.
        RGB565_WIDTH_METERS: 200,

        MAX_TRACK_POINTS: 200,

        TILE_URL: "https://tile.openstreetmap.org",

        USER_AGENT: "ESP32-Map-Project/1.0"
    }
};