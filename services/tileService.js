const fetch = require("node-fetch");
const PImage = require("pureimage");

async function loadTileMatrix(lat, lon, zoom) {
    // calculate center tile
    // download 3x3
    // compose 768x768 PImage
    // return image + positioning information
}

module.exports = {
    loadTileMatrix
};