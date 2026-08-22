const { GPS } = require("../config");

const points = [];

function addPoint(point) {
    points.push(point);

    while (points.length > GPS.MAX_POINTS) {
        points.shift();
    }

    return point;
}

function getPoints() {
    return points;
}

function getLatestPoint() {
    if (points.length === 0) {
        return null;
    }

    return points[points.length - 1];
}

function getPointCount() {
    return points.length;
}

module.exports = {
    addPoint,
    getPoints,
    getLatestPoint,
    getPointCount
};