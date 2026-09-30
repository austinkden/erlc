/**
 * Math and Geometry utilities for Road Network Mapping
 */

// Calculate Euclidean distance between two 2D points
export function dist(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// Calculate squared Euclidean distance (faster for comparisons)
export function distSq(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return dx * dx + dy * dy;
}

// Vector addition
export function add(p1, p2) {
    return { x: p1.x + p2.x, y: p1.y + p2.y };
}

// Vector subtraction
export function sub(p1, p2) {
    return { x: p1.x - p2.x, y: p1.y - p2.y };
}

// Vector scalar multiplication
export function scale(p, s) {
    return { x: p.x * s, y: p.y * s };
}

// Vector length
export function length(p) {
    return Math.hypot(p.x, p.y);
}

// Normalize vector
export function normalize(p) {
    const len = length(p);
    if (len === 0) return { x: 0, y: 0 };
    return { x: p.x / len, y: p.y / len };
}

// Perpendicular vector (rotated 90 degrees counter-clockwise or clockwise)
export function perp(p, sign = 1) {
    return { x: -p.y * sign, y: p.x * sign };
}

// Project point P onto line segment AB, returning the closest point on segment AB
export function projectPointOnSegment(p, a, b) {
    const ab = sub(b, a);
    const abLenSq = distSq(a, b);
    if (abLenSq === 0) return { point: { ...a }, t: 0, dist: dist(p, a) };

    const ap = sub(p, a);
    let t = (ap.x * ab.x + ap.y * ab.y) / abLenSq;
    t = Math.max(0, Math.min(1, t));

    const closest = {
        x: a.x + t * ab.x,
        y: a.y + t * ab.y
    };

    return {
        point: closest,
        t,
        dist: dist(p, closest)
    };
}

// Find closest point and segment on a polyline to point P
export function projectPointOnPolyline(p, waypoints) {
    if (!waypoints || waypoints.length === 0) return null;
    if (waypoints.length === 1) {
        return {
            point: { ...waypoints[0] },
            segmentIndex: 0,
            t: 0,
            dist: dist(p, waypoints[0])
        };
    }

    let minResult = null;
    for (let i = 0; i < waypoints.length - 1; i++) {
        const res = projectPointOnSegment(p, waypoints[i], waypoints[i + 1]);
        if (!minResult || res.dist < minResult.dist) {
            minResult = {
                point: res.point,
                segmentIndex: i,
                t: res.t,
                dist: res.dist
            };
        }
    }
    return minResult;
}

// Calculate total length of a polyline
export function polylineLength(waypoints) {
    let len = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
        len += dist(waypoints[i], waypoints[i + 1]);
    }
    return len;
}

/**
 * Generate a parallel offset polyline.
 * @param {Array<{x: number, y: number}>} points Source waypoints
 * @param {number} offset Distance to offset (+ = right, - = left relative to direction)
 * @param {boolean} reverseDirection Whether the resulting polyline should reverse its waypoint order
 */
export function offsetPolyline(points, offset, reverseDirection = false) {
    if (!points || points.length < 2) return [];

    const offsetPoints = [];

    // Calculate segment normal vectors (pointing to the right of travel direction)
    const segmentNormals = [];
    for (let i = 0; i < points.length - 1; i++) {
        const dir = sub(points[i + 1], points[i]);
        const n = normalize(dir);
        // Normal to right: (dy, -dx)
        segmentNormals.push({ x: n.y, y: -n.x });
    }

    // First point
    offsetPoints.push({
        x: points[0].x + segmentNormals[0].x * offset,
        y: points[0].y + segmentNormals[0].y * offset
    });

    // Intermediate points with corner miter or average normal
    for (let i = 1; i < points.length - 1; i++) {
        const n1 = segmentNormals[i - 1];
        const n2 = segmentNormals[i];
        
        // Average normal
        const avg = normalize({ x: n1.x + n2.x, y: n1.y + n2.y });
        const dot = avg.x * n1.x + avg.y * n1.y;
        
        // Prevent extreme spikes on sharp hairpin corners by clamping miter length
        const miterLength = Math.abs(dot) > 0.1 ? offset / dot : offset;
        const clampedMiter = Math.max(-Math.abs(offset) * 2.5, Math.min(Math.abs(offset) * 2.5, miterLength));

        offsetPoints.push({
            x: points[i].x + avg.x * clampedMiter,
            y: points[i].y + avg.y * clampedMiter
        });
    }

    // Last point
    const lastN = segmentNormals[segmentNormals.length - 1];
    offsetPoints.push({
        x: points[points.length - 1].x + lastN.x * offset,
        y: points[points.length - 1].y + lastN.y * offset
    });

    if (reverseDirection) {
        offsetPoints.reverse();
    }

    return offsetPoints;
}

// Snap an angle to nearest 45 degrees (useful when holding Shift while drawing)
export function snapAngle(start, current) {
    const dx = current.x - start.x;
    const dy = current.y - start.y;
    const r = Math.hypot(dx, dy);
    if (r === 0) return current;

    const angle = Math.atan2(dy, dx);
    const step = Math.PI / 4; // 45 degrees
    const snappedAngle = Math.round(angle / step) * step;

    return {
        x: start.x + r * Math.cos(snappedAngle),
        y: start.y + r * Math.sin(snappedAngle)
    };
}

/**
 * Catmull-Rom Spline Interpolation for smooth curved roads
 * Generates smooth intermediate points through control waypoints.
 */
export function catmullRomSpline(points, samplesPerSegment = 8, tension = 0.5) {
    if (!points || points.length < 3) return points ? [...points] : [];

    const result = [];
    const n = points.length;

    for (let i = 0; i < n - 1; i++) {
        const p0 = i === 0 ? points[0] : points[i - 1];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = i + 2 < n ? points[i + 2] : p2;

        for (let t = 0; t <= samplesPerSegment; t++) {
            // Avoid duplicating endpoints between segments
            if (t === samplesPerSegment && i < n - 2) continue;

            const u = t / samplesPerSegment;
            const u2 = u * u;
            const u3 = u2 * u;

            // Catmull-Rom basis matrix with tension
            const f1 = -tension * u3 + 2 * tension * u2 - tension * u;
            const f2 = (2 - tension) * u3 + (tension - 3) * u2 + 1;
            const f3 = (tension - 2) * u3 + (3 - 2 * tension) * u2 + tension * u;
            const f4 = tension * u3 - tension * u2;

            result.push({
                x: p0.x * f1 + p1.x * f2 + p2.x * f3 + p3.x * f4,
                y: p0.y * f1 + p1.y * f2 + p2.y * f3 + p3.y * f4
            });
        }
    }

    return result;
}

/**
 * Check if a point lies inside a 2D bounding box
 */
export function pointInBox(p, box) {
    return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

/**
 * Check if a line segment intersects or lies inside a 2D bounding box
 */
export function segmentIntersectsBox(p1, p2, box) {
    if (pointInBox(p1, box) || pointInBox(p2, box)) return true;

    // Line bounding box check
    const segMinX = Math.min(p1.x, p2.x);
    const segMaxX = Math.max(p1.x, p2.x);
    const segMinY = Math.min(p1.y, p2.y);
    const segMaxY = Math.max(p1.y, p2.y);

    if (segMaxX < box.minX || segMinX > box.maxX || segMaxY < box.minY || segMinY > box.maxY) {
        return false;
    }

    // Segment intersection with all 4 box sides
    const edges = [
        [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }],
        [{ x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }],
        [{ x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }],
        [{ x: box.minX, y: box.maxY }, { x: box.minX, y: box.minY }]
    ];

    for (const [e1, e2] of edges) {
        if (segmentsIntersect(p1, p2, e1, e2)) return true;
    }

    return false;
}

function segmentsIntersect(a, b, c, d) {
    const ccw = (p1, p2, p3) => (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

/**
 * Calculate signed turning angle from vector 1 (approach) to vector 2 (exit) in degrees [-180, +180]
 * Positive = Right turn, Negative = Left turn
 */
export function calculateTurnAngle(vIn, vOut) {
    const angleIn = Math.atan2(vIn.y, vIn.x);
    const angleOut = Math.atan2(vOut.y, vOut.x);
    let diff = (angleOut - angleIn) * (180 / Math.PI);
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    return diff;
}

/**
 * Convert a signed turn angle in degrees to human-readable GPS instructions
 */
export function describeTurn(angleDeg) {
    if (Math.abs(angleDeg) <= 22.5) return { type: 'straight', label: 'Continue straight' };
    if (angleDeg > 22.5 && angleDeg <= 60) return { type: 'slight_right', label: 'Bear right' };
    if (angleDeg > 60 && angleDeg <= 120) return { type: 'turn_right', label: 'Turn right' };
    if (angleDeg > 120 && angleDeg <= 165) return { type: 'sharp_right', label: 'Sharp right' };
    if (angleDeg < -22.5 && angleDeg >= -60) return { type: 'slight_left', label: 'Bear left' };
    if (angleDeg < -60 && angleDeg >= -120) return { type: 'turn_left', label: 'Turn left' };
    if (angleDeg < -120 && angleDeg >= -165) return { type: 'sharp_left', label: 'Sharp left' };
    return { type: 'u_turn', label: 'Make a U-turn' };
}

/**
 * Generate circular polyline points for a roundabout or cul-de-sac
 */
export function generateRoundaboutPoints(center, radius, numPoints = 16, clockwise = true) {
    const pts = [];
    const step = (Math.PI * 2) / numPoints;
    for (let i = 0; i < numPoints; i++) {
        const theta = clockwise ? i * step : -i * step;
        pts.push({
            x: center.x + radius * Math.cos(theta),
            y: center.y + radius * Math.sin(theta)
        });
    }
    // Close the loop
    pts.push({ ...pts[0] });
    return pts;
}

