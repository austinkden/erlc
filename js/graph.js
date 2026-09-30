/**
 * Road Network Graph Data Model
 * Handles nodes, directed lanes, merging, demerging, turn restrictions, and undo/redo history.
 */
import { 
    dist, 
    distSq, 
    projectPointOnPolyline, 
    offsetPolyline, 
    catmullRomSpline,
    calculateTurnAngle,
    describeTurn,
    generateRoundaboutPoints,
    polylineLength,
    pointInBox,
    segmentIntersectsBox
} from './math.js';

export class RoadGraph {
    constructor() {
        this.nodes = new Map();       // id -> { id, x, y }
        this.lanes = new Map();       // id -> { id, name, speedLimit, material, oneWay, layer, smooth, waypoints, startNodeId, endNodeId }
        this.connectors = new Map();  // id -> { id, fromLaneId, toLaneId, type: 'lane_change'|'merge'|'demerge', allowed: true }
        this.turnRestrictions = new Map(); // `${nodeId}:${fromLaneId}:${toLaneId}` -> boolean (false = prohibited)
        
        // Calibration: Pixels to Game Units (e.g. Roblox studs or meters)
        this.calibration = {
            pixelsPerStud: 2.0, // Default: 2 pixels = 1 stud
            originX: 0,
            originY: 0
        };

        // History for Undo / Redo
        this.undoStack = [];
        this.redoStack = [];
        this.maxHistory = 50;

        this.idCounter = 1;
        this.listeners = new Set();
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify(eventType, data) {
        for (const listener of this.listeners) {
            try {
                listener(eventType, data);
            } catch (err) {
                console.error("Graph listener error:", err);
            }
        }
    }

    generateId(prefix = 'obj') {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    }

    pushHistory() {
        const snapshot = this.serialize();
        this.undoStack.push(snapshot);
        if (this.undoStack.length > this.maxHistory) {
            this.undoStack.shift();
        }
        this.redoStack = []; // Clear redo on new action
        console.log(`[RoadGraph:History] Snapshot pushed (undo: ${this.undoStack.length}, redo: 0)`);
        this.notify('history_changed', { canUndo: this.canUndo(), canRedo: this.canRedo() });
    }

    canUndo() {
        return this.undoStack.length > 0;
    }

    canRedo() {
        return this.redoStack.length > 0;
    }

    undo() {
        if (!this.canUndo()) return false;
        const current = this.serialize();
        this.redoStack.push(current);
        const previous = this.undoStack.pop();
        this.deserialize(previous, false);
        console.log(`[RoadGraph:Undo] Reverted to previous state (undo remaining: ${this.undoStack.length}, redo available: ${this.redoStack.length})`);
        this.notify('history_changed', { canUndo: this.canUndo(), canRedo: this.canRedo() });
        this.notify('graph_mutated', { action: 'undo' });
        return true;
    }

    redo() {
        if (!this.canRedo()) return false;
        const current = this.serialize();
        this.undoStack.push(current);
        const next = this.redoStack.pop();
        this.deserialize(next, false);
        console.log(`[RoadGraph:Redo] Re-applied state (undo available: ${this.undoStack.length}, redo remaining: ${this.redoStack.length})`);
        this.notify('history_changed', { canUndo: this.canUndo(), canRedo: this.canRedo() });
        this.notify('graph_mutated', { action: 'redo' });
        return true;
    }

    // Node Operations
    addNode(x, y, id = null) {
        const nodeId = id || this.generateId('node');
        const node = { id: nodeId, x, y };
        this.nodes.set(nodeId, node);
        console.log(`[RoadGraph:Node] Created junction node ${nodeId} at (${Math.round(x)}, ${Math.round(y)})`);
        return node;
    }

    getNode(id) {
        return this.nodes.get(id);
    }

    findOrCreateNodeAt(x, y, tolerance = 5) {
        for (const node of this.nodes.values()) {
            if (dist(node, { x, y }) <= tolerance) {
                return node;
            }
        }
        return this.addNode(x, y);
    }

    moveNode(nodeId, x, y) {
        const node = this.nodes.get(nodeId);
        if (!node) return null;
        node.x = x;
        node.y = y;

        let attachedCount = 0;
        // Synchronously update all attached lanes' endpoints
        for (const lane of this.lanes.values()) {
            let updated = false;
            if (lane.startNodeId === nodeId && lane.waypoints && lane.waypoints.length > 0) {
                lane.waypoints[0].x = x;
                lane.waypoints[0].y = y;
                updated = true;
            }
            if (lane.endNodeId === nodeId && lane.waypoints && lane.waypoints.length > 0) {
                lane.waypoints[lane.waypoints.length - 1].x = x;
                lane.waypoints[lane.waypoints.length - 1].y = y;
                updated = true;
            }
            if (updated) attachedCount++;
        }

        console.log(`[RoadGraph:Node] Moved node ${nodeId} to (${Math.round(x)}, ${Math.round(y)}) [updated ${attachedCount} attached lane endpoints]`);
        this.notify('node_updated', { node });
        return node;
    }

    // Lane Operations
    createLane(options) {
        this.pushHistory();

        const laneId = options.id || this.generateId('lane');
        const waypoints = options.waypoints || [];
        if (waypoints.length < 2) {
            throw new Error("A lane requires at least 2 waypoints.");
        }

        // Connect or create start and end nodes
        let startNode = options.startNodeId ? this.getNode(options.startNodeId) : null;
        if (!startNode) {
            startNode = this.findOrCreateNodeAt(waypoints[0].x, waypoints[0].y, 10);
        }
        // Snap first waypoint precisely to start node
        waypoints[0] = { x: startNode.x, y: startNode.y };

        let endNode = options.endNodeId ? this.getNode(options.endNodeId) : null;
        if (!endNode) {
            endNode = this.findOrCreateNodeAt(waypoints[waypoints.length - 1].x, waypoints[waypoints.length - 1].y, 10);
        }
        // Snap last waypoint precisely to end node
        waypoints[waypoints.length - 1] = { x: endNode.x, y: endNode.y };

        const lane = {
            id: laneId,
            name: options.name || '',
            speedLimit: options.speedLimit !== undefined ? options.speedLimit : 35,
            material: options.material || 'paved', // 'paved', 'wood', 'dirt'
            oneWay: options.oneWay !== undefined ? options.oneWay : true,
            layer: options.layer !== undefined ? options.layer : 0, // -1 Tunnel, 0 Ground, 1 Bridge, 2 Flyover
            smooth: !!options.smooth, // Catmull-Rom spline smoothing
            startNodeId: startNode.id,
            endNodeId: endNode.id,
            waypoints: waypoints.map(p => ({ x: p.x, y: p.y })),
            restrictions: options.restrictions || []
        };

        this.lanes.set(laneId, lane);
        this.cleanupOrphanNodes();
        console.log(`[RoadGraph:Lane] Created lane ${laneId} "${lane.name || 'unnamed'}" (${lane.waypoints.length} waypoints, speed: ${lane.speedLimit}mph, material: ${lane.material}, oneWay: ${lane.oneWay}, layer: ${lane.layer})`);
        this.notify('lane_created', { lane });
        return lane;
    }

    getEffectiveWaypoints(lane) {
        if (!lane || !lane.waypoints) return [];
        if (lane.smooth && lane.waypoints.length >= 3) {
            return catmullRomSpline(lane.waypoints, 8, 0.5);
        }
        return lane.waypoints;
    }

    updateLane(id, updates) {
        const lane = this.lanes.get(id);
        if (!lane) return null;
        this.pushHistory();
        Object.assign(lane, updates);
        console.log(`[RoadGraph:Lane] Updated lane ${id}:`, updates);
        this.notify('lane_updated', { lane });
        return lane;
    }

    deleteLane(id) {
        const lane = this.lanes.get(id);
        if (!lane) return false;
        this.pushHistory();

        this.lanes.delete(id);

        // Delete connected connectors
        let deletedConnectors = 0;
        for (const [connId, conn] of this.connectors.entries()) {
            if (conn.fromLaneId === id || conn.toLaneId === id) {
                this.connectors.delete(connId);
                deletedConnectors++;
            }
        }

        this.cleanupOrphanNodes();
        console.log(`[RoadGraph:Lane] Deleted lane ${id} (removed ${deletedConnectors} connectors)`);
        this.notify('lane_deleted', { laneId: id });
        return true;
    }

    reverseLane(id) {
        const lane = this.lanes.get(id);
        if (!lane) return false;
        this.pushHistory();

        // Reverse waypoints
        lane.waypoints.reverse();

        // Swap start and end nodes
        const temp = lane.startNodeId;
        lane.startNodeId = lane.endNodeId;
        lane.endNodeId = temp;

        console.log(`[RoadGraph:Lane] Reversed lane direction for ${id}`);
        this.notify('lane_updated', { lane });
        return true;
    }

    insertWaypoint(laneId, index, point) {
        const lane = this.lanes.get(laneId);
        if (!lane || !point) return false;
        this.pushHistory();

        const insertIdx = Math.max(1, Math.min(lane.waypoints.length - 1, index));
        lane.waypoints.splice(insertIdx, 0, { x: point.x, y: point.y });

        console.log(`[RoadGraph:Waypoint] Inserted waypoint into ${laneId} at index ${insertIdx} (${Math.round(point.x)}, ${Math.round(point.y)})`);
        this.notify('lane_updated', { lane });
        return true;
    }

    removeWaypoint(laneId, index) {
        const lane = this.lanes.get(laneId);
        if (!lane) return false;
        if (lane.waypoints.length <= 2) {
            throw new Error("A lane must have at least 2 points.");
        }
        this.pushHistory();

        if (index === 0) {
            lane.waypoints.splice(0, 1);
            const newStart = lane.waypoints[0];
            const newStartNode = this.findOrCreateNodeAt(newStart.x, newStart.y, 8);
            lane.startNodeId = newStartNode.id;
            this.cleanupOrphanNodes();
        } else if (index === lane.waypoints.length - 1) {
            lane.waypoints.splice(lane.waypoints.length - 1, 1);
            const newEnd = lane.waypoints[lane.waypoints.length - 1];
            const newEndNode = this.findOrCreateNodeAt(newEnd.x, newEnd.y, 8);
            lane.endNodeId = newEndNode.id;
            this.cleanupOrphanNodes();
        } else {
            lane.waypoints.splice(index, 1);
        }

        console.log(`[RoadGraph:Waypoint] Removed waypoint index ${index} from ${laneId} (remaining: ${lane.waypoints.length} points)`);
        this.notify('lane_updated', { lane });
        return true;
    }

    splitLaneAtWaypoint(laneId, waypointIndex) {
        const lane = this.lanes.get(laneId);
        if (!lane || waypointIndex <= 0 || waypointIndex >= lane.waypoints.length - 1) {
            return null;
        }
        this.pushHistory();

        const splitPoint = lane.waypoints[waypointIndex];
        const splitNode = this.findOrCreateNodeAt(splitPoint.x, splitPoint.y, 5);

        // First half keeps the original lane id
        const firstHalfWaypoints = lane.waypoints.slice(0, waypointIndex + 1);
        const secondHalfWaypoints = lane.waypoints.slice(waypointIndex);

        const oldEndNodeId = lane.endNodeId;

        lane.waypoints = firstHalfWaypoints;
        lane.endNodeId = splitNode.id;

        // Second half gets a new lane
        const newLane = this.createLane({
            name: lane.name,
            group: lane.group,
            speedLimit: lane.speedLimit,
            oneWay: lane.oneWay,
            startNodeId: splitNode.id,
            endNodeId: oldEndNodeId,
            waypoints: secondHalfWaypoints,
            laneType: lane.laneType
        });

        this.notify('lane_split', { originalLane: lane, newLane });
        console.log(`[RoadGraph:Lane] Split lane ${laneId} at waypoint index ${waypointIndex} into new lane ${newLane.id}`);
        return { lane1: lane, lane2: newLane };
    }

    duplicateParallelLane(laneId, offsetDistance = 24, reverseDirection = false) {
        const sourceLane = this.lanes.get(laneId);
        if (!sourceLane) return null;

        const offsetPoints = offsetPolyline(sourceLane.waypoints, offsetDistance, reverseDirection);
        if (offsetPoints.length < 2) return null;

        const dupLane = this.createLane({
            name: sourceLane.name,
            speedLimit: sourceLane.speedLimit,
            material: sourceLane.material || 'paved',
            oneWay: sourceLane.oneWay,
            waypoints: offsetPoints
        });
        console.log(`[RoadGraph:Lane] Duplicated parallel lane from ${laneId} -> new lane ${dupLane.id} (offset: ${offsetDistance}px, reversed: ${reverseDirection})`);
        return dupLane;
    }

    // Connectors / Lane Changes / Turn Restrictions
    addConnector(fromLaneId, toLaneId, type = 'lane_change', allowed = true) {
        if (!this.lanes.has(fromLaneId) || !this.lanes.has(toLaneId)) return null;
        this.pushHistory();

        const id = this.generateId('conn');
        const conn = { id, fromLaneId, toLaneId, type, allowed };
        this.connectors.set(id, conn);
        console.log(`[RoadGraph:Connector] Added connector ${id} (${fromLaneId} -> ${toLaneId}, type: ${type})`);
        this.notify('connector_added', { connector: conn });
        return conn;
    }

    removeConnector(id) {
        if (this.connectors.has(id)) {
            this.pushHistory();
            this.connectors.delete(id);
            console.log(`[RoadGraph:Connector] Removed connector ${id}`);
            this.notify('connector_removed', { id });
            return true;
        }
        return false;
    }

    // Clean up nodes that have no lane connecting to them
    cleanupOrphanNodes() {
        const usedNodeIds = new Set();
        for (const lane of this.lanes.values()) {
            if (lane.startNodeId) usedNodeIds.add(lane.startNodeId);
            if (lane.endNodeId) usedNodeIds.add(lane.endNodeId);
        }

        for (const nodeId of Array.from(this.nodes.keys())) {
            if (!usedNodeIds.has(nodeId)) {
                this.nodes.delete(nodeId);
            }
        }
    }

    // Snapping Logic
    findSnapTarget(pos, snapRadius = 18, excludeLaneId = null, targetLayer = null) {
        // 1. Check existing junction nodes first (highest priority)
        let closestNode = null;
        let minNodeDist = snapRadius;
        for (const node of this.nodes.values()) {
            // If targetLayer specified, only snap to nodes matching that elevation layer
            if (targetLayer !== null) {
                const junc = this.getJunctionSummary(node.id);
                const hasMatchingLayer = [...junc.incomingLanes, ...junc.outgoingLanes].some(l => (l.layer || 0) === targetLayer);
                if (!hasMatchingLayer && (junc.incomingCount + junc.outgoingCount) > 0) continue;
            }

            const d = dist(pos, node);
            if (d < minNodeDist) {
                minNodeDist = d;
                closestNode = node;
            }
        }
        if (closestNode) {
            return {
                type: 'node',
                node: closestNode,
                point: { x: closestNode.x, y: closestNode.y },
                distance: minNodeDist
            };
        }

        // 2. Check lane waypoints & segments
        let closestLaneResult = null;
        let minLaneDist = snapRadius;

        for (const lane of this.lanes.values()) {
            if (excludeLaneId && lane.id === excludeLaneId) continue;
            // Respect elevation layer
            if (targetLayer !== null && (lane.layer || 0) !== targetLayer) continue;

            const waypoints = this.getEffectiveWaypoints(lane);
            const proj = projectPointOnPolyline(pos, waypoints);
            if (proj && proj.dist < minLaneDist) {
                minLaneDist = proj.dist;
                closestLaneResult = {
                    type: 'lane',
                    lane,
                    point: proj.point,
                    segmentIndex: proj.segmentIndex,
                    distance: proj.dist
                };
            }
        }

        return closestLaneResult;
    }

    // Turn Restrictions
    getTurnKey(nodeId, fromLaneId, toLaneId) {
        return `${nodeId}:${fromLaneId}:${toLaneId}`;
    }

    setTurnAllowed(nodeId, fromLaneId, toLaneId, isAllowed) {
        this.pushHistory();
        const key = this.getTurnKey(nodeId, fromLaneId, toLaneId);
        if (isAllowed) {
            this.turnRestrictions.delete(key);
        } else {
            this.turnRestrictions.set(key, false);
        }
        this.notify('turn_restriction_changed', { nodeId, fromLaneId, toLaneId, allowed: isAllowed });
        console.log(`[RoadGraph:TurnRestriction] Node ${nodeId}: Lane ${fromLaneId} -> Lane ${toLaneId} allowed=${isAllowed}`);
    }

    isTurnAllowed(nodeId, fromLaneId, toLaneId) {
        if (!fromLaneId || !toLaneId) return true;
        const key = this.getTurnKey(nodeId, fromLaneId, toLaneId);
        return this.turnRestrictions.get(key) !== false;
    }

    // A* Pathfinding & GPS Navigation
    findRoute(startNodeId, targetNodeId, options = {}) {
        const emergency = !!options.emergency;
        const metric = options.costMetric || 'time';
        const pps = this.calibration.pixelsPerStud || 2.0;

        if (!this.nodes.has(startNodeId) || !this.nodes.has(targetNodeId)) {
            console.warn(`[RoadGraph:Pathfinding] Node not found: start=${startNodeId}, target=${targetNodeId}`);
            return { found: false, error: 'Start or target node not found.' };
        }
        console.log(`[RoadGraph:Pathfinding] Route search: ${startNodeId} -> ${targetNodeId} (emergency: ${emergency})`);

        if (startNodeId === targetNodeId) {
            const startNode = this.nodes.get(startNodeId);
            return {
                found: true,
                nodes: [startNodeId],
                lanes: [],
                waypoints: [{ x: startNode.x, y: startNode.y }],
                totalDistanceStuds: 0,
                estimatedTimeSeconds: 0,
                instructions: [{ type: 'arrive', text: 'You are at your destination', distanceStuds: 0, streetName: '' }]
            };
        }

        const distances = new Map();
        const previous = new Map();
        const visited = new Set();
        const targetNode = this.nodes.get(targetNodeId);

        const queue = [{ nodeId: startNodeId, cost: 0, prevLaneId: null }];
        distances.set(startNodeId, 0);

        while (queue.length > 0) {
            queue.sort((a, b) => a.cost - b.cost);
            const current = queue.shift();
            const u = current.nodeId;

            if (u === targetNodeId) break;
            if (visited.has(u)) continue;
            visited.add(u);

            const currDist = distances.get(u) || 0;

            for (const lane of this.lanes.values()) {
                let v = null;
                let isForward = true;

                if (lane.startNodeId === u) {
                    v = lane.endNodeId;
                    isForward = true;
                } else if (lane.endNodeId === u && (!lane.oneWay || emergency)) {
                    v = lane.startNodeId;
                    isForward = false;
                }

                if (!v) continue;

                if (current.prevLaneId && !emergency) {
                    if (!this.isTurnAllowed(u, current.prevLaneId, lane.id)) {
                        continue;
                    }
                }

                const lanePts = this.getEffectiveWaypoints(lane);
                const segLen = polylineLength(lanePts);
                const speed = lane.speedLimit || 35;
                const edgeCost = metric === 'distance' ? segLen : (segLen / Math.max(15, speed));
                const newCost = currDist + edgeCost;

                if (!distances.has(v) || newCost < distances.get(v)) {
                    distances.set(v, newCost);
                    previous.set(v, {
                        prevNode: u,
                        lane,
                        isForward,
                        cost: newCost
                    });

                    const vNode = this.nodes.get(v);
                    const h = vNode ? (dist(vNode, targetNode) / (metric === 'distance' ? 1 : 65)) : 0;
                    queue.push({ nodeId: v, cost: newCost + h, prevLaneId: lane.id });
                }
            }
        }

        if (!previous.has(targetNodeId)) {
            return { found: false, error: 'No route could be found connecting these points.' };
        }

        const pathNodes = [];
        const pathLanes = [];
        const pathSegments = [];
        let curr = targetNodeId;

        while (curr !== startNodeId) {
            pathNodes.unshift(curr);
            const step = previous.get(curr);
            if (!step) break;
            pathLanes.unshift(step.lane);
            pathSegments.unshift(step);
            curr = step.prevNode;
        }
        pathNodes.unshift(startNodeId);

        const combinedWaypoints = [];
        let totalPixelLen = 0;
        let totalSeconds = 0;

        for (let i = 0; i < pathSegments.length; i++) {
            const step = pathSegments[i];
            const lanePts = this.getEffectiveWaypoints(step.lane);
            const pts = step.isForward ? lanePts : [...lanePts].reverse();

            const segLen = polylineLength(pts);
            totalPixelLen += segLen;
            const speedMph = step.lane.speedLimit || 35;
            const speedStudsPerSec = Math.max(10, speedMph * 1.466);
            totalSeconds += (segLen / pps) / speedStudsPerSec;

            for (let j = 0; j < pts.length; j++) {
                if (combinedWaypoints.length > 0 && j === 0) continue;
                combinedWaypoints.push(pts[j]);
            }
        }

        const instructions = [];
        for (let i = 0; i < pathSegments.length; i++) {
            const step = pathSegments[i];
            const lane = step.lane;
            const lanePts = this.getEffectiveWaypoints(lane);
            const pts = step.isForward ? lanePts : [...lanePts].reverse();
            const segDistStuds = Math.round(polylineLength(pts) / pps);
            const roadName = lane.name || 'Unnamed Road';

            if (i === 0) {
                instructions.push({
                    type: 'depart',
                    text: `Head on ${roadName}`,
                    distanceStuds: segDistStuds,
                    streetName: roadName,
                    material: lane.material || 'paved'
                });
            } else {
                const prevStep = pathSegments[i - 1];
                const prevLanePts = this.getEffectiveWaypoints(prevStep.lane);
                const prevPts = prevStep.isForward ? prevLanePts : [...prevLanePts].reverse();
                
                const vIn = {
                    x: prevPts[prevPts.length - 1].x - prevPts[prevPts.length - 2].x,
                    y: prevPts[prevPts.length - 1].y - prevPts[prevPts.length - 2].y
                };
                const vOut = {
                    x: pts[1].x - pts[0].x,
                    y: pts[1].y - pts[0].y
                };

                const turnAngle = calculateTurnAngle(vIn, vOut);
                const turnDesc = describeTurn(turnAngle);

                let text = `${turnDesc.label} onto ${roadName}`;
                if (turnDesc.type === 'straight' && prevStep.lane.name === lane.name) {
                    text = `Continue on ${roadName}`;
                }

                instructions.push({
                    type: turnDesc.type,
                    text,
                    distanceStuds: segDistStuds,
                    streetName: roadName,
                    turnAngleDeg: Math.round(turnAngle),
                    material: lane.material || 'paved'
                });
            }
        }

        instructions.push({
            type: 'arrive',
            text: 'Arrive at destination',
            distanceStuds: 0,
            streetName: pathSegments[pathSegments.length - 1]?.lane?.name || ''
        });

        console.log(`[RoadGraph:Pathfinding] Route solved: ${pathNodes.length} nodes, ${pathLanes.length} lanes, ${Math.round(totalPixelLen / pps)} studs (~${Math.round(totalSeconds)}s)`);
        return {
            found: true,
            nodes: pathNodes,
            lanes: pathLanes,
            waypoints: combinedWaypoints,
            totalDistanceStuds: Math.round(totalPixelLen / pps),
            estimatedTimeSeconds: Math.round(totalSeconds),
            instructions
        };
    }

    // Graph Diagnostics & Audit
    runAudit() {
        const issues = [];
        const pps = this.calibration.pixelsPerStud || 2.0;

        // 1. Disconnected and dead end nodes
        for (const node of this.nodes.values()) {
            const junc = this.getJunctionSummary(node.id);
            if (junc.incomingCount === 0 && junc.outgoingCount === 0) {
                issues.push({
                    id: this.generateId('issue'),
                    type: 'orphan_node',
                    severity: 'warning',
                    nodeId: node.id,
                    coords: { x: node.x, y: node.y },
                    message: `Disconnected Node #${node.id.slice(-4)} has no lanes.`
                });
            } else if (junc.incomingCount + junc.outgoingCount === 1) {
                issues.push({
                    id: this.generateId('issue'),
                    type: 'dead_end',
                    severity: 'info',
                    nodeId: node.id,
                    coords: { x: node.x, y: node.y },
                    message: `Dead end at Node #${node.id.slice(-4)}.`
                });
            }
        }

        // 2. Near-duplicate nodes (< 4 studs)
        const nodeList = Array.from(this.nodes.values());
        for (let i = 0; i < nodeList.length; i++) {
            for (let j = i + 1; j < nodeList.length; j++) {
                const n1 = nodeList[i];
                const n2 = nodeList[j];
                const d = dist(n1, n2);
                if (d < 4 * pps && d > 0.01) {
                    issues.push({
                        id: this.generateId('issue'),
                        type: 'near_duplicate',
                        severity: 'warning',
                        nodeIds: [n1.id, n2.id],
                        distanceStuds: Math.round(d / pps * 10) / 10,
                        coords: { x: (n1.x + n2.x) / 2, y: (n1.y + n2.y) / 2 },
                        message: `Nodes #${n1.id.slice(-4)} and #${n2.id.slice(-4)} are only ${(d/pps).toFixed(1)} studs apart.`
                    });
                }
            }
        }

        console.log(`[RoadGraph:Diagnostics] Audit completed: found ${issues.length} potential issue(s)`);
        return issues;
    }

    // Merge near-duplicate nodes within tolerance
    mergeNearNodes(toleranceStuds = 4) {
        this.pushHistory();
        const pps = this.calibration.pixelsPerStud || 2.0;
        const tolPx = toleranceStuds * pps;
        let merged = 0;

        const nodes = Array.from(this.nodes.values());
        const mergedInto = new Map();

        for (let i = 0; i < nodes.length; i++) {
            const n1 = nodes[i];
            const targetId1 = mergedInto.get(n1.id) || n1.id;

            for (let j = i + 1; j < nodes.length; j++) {
                const n2 = nodes[j];
                const targetId2 = mergedInto.get(n2.id) || n2.id;
                if (targetId1 === targetId2) continue;

                const actualNode1 = this.nodes.get(targetId1);
                const actualNode2 = this.nodes.get(targetId2);
                if (!actualNode1 || !actualNode2) continue;

                if (dist(actualNode1, actualNode2) <= tolPx) {
                    mergedInto.set(actualNode2.id, actualNode1.id);
                    for (const lane of this.lanes.values()) {
                        if (lane.startNodeId === actualNode2.id) {
                            lane.startNodeId = actualNode1.id;
                            lane.waypoints[0] = { x: actualNode1.x, y: actualNode1.y };
                        }
                        if (lane.endNodeId === actualNode2.id) {
                            lane.endNodeId = actualNode1.id;
                            lane.waypoints[lane.waypoints.length - 1] = { x: actualNode1.x, y: actualNode1.y };
                        }
                    }
                    this.nodes.delete(actualNode2.id);
                    merged++;
                }
            }
        }

        this.cleanupOrphanNodes();
        console.log(`[RoadGraph:Diagnostics] Merged ${merged} near-duplicate node(s) within ${toleranceStuds} studs tolerance`);
        this.notify('nodes_merged', { mergedCount: merged });
        return { mergedCount: merged };
    }

    // Procedural Roundabout Generator
    createRoundabout({ center, radiusStuds = 35, numArms = 4, speedLimit = 25, material = 'paved', layer = 0 }) {
        this.pushHistory();
        const pps = this.calibration.pixelsPerStud || 2.0;
        const radiusPx = radiusStuds * pps;

        const ringPts = generateRoundaboutPoints(center, radiusPx, 16, true);
        const ringLane = this.createLane({
            name: 'Roundabout',
            speedLimit,
            material,
            oneWay: true,
            layer,
            smooth: true,
            waypoints: ringPts
        });

        const armLanes = [];
        const armLengthPx = 35 * pps;
        for (let i = 0; i < numArms; i++) {
            const angle = (Math.PI * 2 / numArms) * i;
            const ringPoint = {
                x: center.x + radiusPx * Math.cos(angle),
                y: center.y + radiusPx * Math.sin(angle)
            };
            const armOuterPoint = {
                x: center.x + (radiusPx + armLengthPx) * Math.cos(angle),
                y: center.y + (radiusPx + armLengthPx) * Math.sin(angle)
            };

            const armLane = this.createLane({
                name: 'Roundabout Arm',
                speedLimit,
                material,
                oneWay: false,
                layer,
                waypoints: [armOuterPoint, ringPoint]
            });
            armLanes.push(armLane);
        }

        console.log(`[RoadGraph:Procedural] Generated Roundabout at (${Math.round(center.x)}, ${Math.round(center.y)}) with ${numArms} arms, radius: ${radiusStuds} studs`);
        this.notify('roundabout_created', { ringLane, armLanes });
        return { ringLane, armLanes };
    }

    // Procedural Cul-de-sac Generator
    createCulDeSac({ center, bulbRadiusStuds = 25, stemLengthStuds = 50, angleDeg = 0, speedLimit = 25, material = 'paved', layer = 0 }) {
        this.pushHistory();
        const pps = this.calibration.pixelsPerStud || 2.0;
        const bulbRadiusPx = bulbRadiusStuds * pps;
        const stemLengthPx = stemLengthStuds * pps;
        const theta = angleDeg * (Math.PI / 180);

        const stemStart = {
            x: center.x - stemLengthPx * Math.cos(theta),
            y: center.y - stemLengthPx * Math.sin(theta)
        };

        const bulbPts = generateRoundaboutPoints(center, bulbRadiusPx, 12, true);

        const stemLane = this.createLane({
            name: 'Cul-de-sac Access',
            speedLimit,
            material,
            oneWay: false,
            layer,
            waypoints: [stemStart, { x: center.x, y: center.y }]
        });

        const bulbLane = this.createLane({
            name: 'Cul-de-sac Loop',
            speedLimit,
            material,
            oneWay: true,
            layer,
            smooth: true,
            waypoints: bulbPts
        });

        console.log(`[RoadGraph:Procedural] Generated Cul-de-sac at (${Math.round(center.x)}, ${Math.round(center.y)}) stem: ${stemLengthStuds} studs, bulb: ${bulbRadiusStuds} studs`);
        this.notify('culdesac_created', { stemLane, bulbLane });
        return { stemLane, bulbLane };
    }

    // Box Marquee Selection
    selectByBox(box) {
        const selectedNodes = [];
        const selectedLanes = [];

        // Check nodes inside box
        for (const node of this.nodes.values()) {
            if (pointInBox(node, box)) {
                selectedNodes.push(node.id);
            }
        }

        // Check lanes intersecting or inside box
        for (const lane of this.lanes.values()) {
            const pts = this.getEffectiveWaypoints(lane);
            let intersects = false;
            for (let i = 0; i < pts.length - 1; i++) {
                if (segmentIntersectsBox(pts[i], pts[i + 1], box)) {
                    intersects = true;
                    break;
                }
            }
            if (intersects) {
                selectedLanes.push(lane.id);
            }
        }

        console.log(`[RoadGraph:Selection] Box selection matched ${selectedLanes.length} lanes and ${selectedNodes.length} nodes:`, { lanes: selectedLanes, nodes: selectedNodes });
        return { laneIds: selectedLanes, nodeIds: selectedNodes };
    }

    // Detect Merges and Demerges
    getJunctionSummary(nodeId) {
        const incoming = [];
        const outgoing = [];

        for (const lane of this.lanes.values()) {
            if (lane.endNodeId === nodeId) incoming.push(lane);
            if (lane.startNodeId === nodeId) outgoing.push(lane);
        }

        return {
            nodeId,
            incomingCount: incoming.length,
            outgoingCount: outgoing.length,
            incomingLanes: incoming,
            outgoingLanes: outgoing,
            isMerge: incoming.length > 1,
            isDemerge: outgoing.length > 1,
            isIntersection: (incoming.length + outgoing.length) > 2
        };
    }

    // Statistics
    getStats() {
        let totalLength = 0;
        for (const lane of this.lanes.values()) {
            for (let i = 0; i < lane.waypoints.length - 1; i++) {
                totalLength += dist(lane.waypoints[i], lane.waypoints[i + 1]);
            }
        }

        let merges = 0;
        let demerges = 0;
        for (const node of this.nodes.values()) {
            const j = this.getJunctionSummary(node.id);
            if (j.isMerge) merges++;
            if (j.isDemerge) demerges++;
        }

        return {
            laneCount: this.lanes.size,
            nodeCount: this.nodes.size,
            connectorCount: this.connectors.size,
            totalPixelLength: Math.round(totalLength),
            totalStuds: Math.round(totalLength / this.calibration.pixelsPerStud),
            mergesCount: merges,
            demergesCount: demerges
        };
    }

    // Clear Graph
    clear() {
        this.pushHistory();
        const prevCounts = { nodes: this.nodes.size, lanes: this.lanes.size, connectors: this.connectors.size };
        this.nodes.clear();
        this.lanes.clear();
        this.connectors.clear();
        console.log(`[RoadGraph:Clear] Network cleared (removed ${prevCounts.lanes} lanes, ${prevCounts.nodes} nodes, ${prevCounts.connectors} connectors)`);
        this.notify('graph_cleared', {});
    }

    // Serialization
    serialize() {
        return JSON.stringify({
            version: 1,
            calibration: this.calibration,
            nodes: Array.from(this.nodes.values()),
            lanes: Array.from(this.lanes.values()),
            connectors: Array.from(this.connectors.values())
        });
    }

    deserialize(jsonString, saveHistory = true) {
        if (saveHistory) this.pushHistory();
        const data = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;

        this.nodes.clear();
        this.lanes.clear();
        this.connectors.clear();

        if (data.calibration) {
            this.calibration = { ...this.calibration, ...data.calibration };
        }

        if (Array.isArray(data.nodes)) {
            for (const n of data.nodes) {
                this.nodes.set(n.id, n);
            }
        }

        if (Array.isArray(data.lanes)) {
            for (const l of data.lanes) {
                this.lanes.set(l.id, l);
            }
        }

        if (Array.isArray(data.connectors)) {
            for (const c of data.connectors) {
                this.connectors.set(c.id, c);
            }
        }

        this.cleanupOrphanNodes();
        console.log(`[RoadGraph:Load] Deserialized graph: ${this.lanes.size} lanes, ${this.nodes.size} nodes, ${this.connectors.size} connectors`);
        this.notify('graph_loaded', {});
    }

    // GeoJSON Export
    toGeoJSON() {
        const features = [];

        // Lanes as LineStrings
        for (const lane of this.lanes.values()) {
            features.push({
                type: 'Feature',
                id: lane.id,
                properties: {
                    id: lane.id,
                    name: lane.name,
                    speedLimit: lane.speedLimit,
                    material: lane.material || 'paved',
                    oneWay: lane.oneWay,
                    startNodeId: lane.startNodeId,
                    endNodeId: lane.endNodeId,
                    restrictions: lane.restrictions
                },
                geometry: {
                    type: 'LineString',
                    coordinates: lane.waypoints.map(p => [p.x, p.y])
                }
            });
        }

        // Junction Nodes as Points
        for (const node of this.nodes.values()) {
            const junc = this.getJunctionSummary(node.id);
            features.push({
                type: 'Feature',
                id: node.id,
                properties: {
                    id: node.id,
                    isMerge: junc.isMerge,
                    isDemerge: junc.isDemerge,
                    incomingLanes: junc.incomingLanes.map(l => l.id),
                    outgoingLanes: junc.outgoingLanes.map(l => l.id)
                },
                geometry: {
                    type: 'Point',
                    coordinates: [node.x, node.y]
                }
            });
        }

        console.log(`[RoadGraph:Export] Exported GeoJSON FeatureCollection with ${features.length} features`);
        return {
            type: 'FeatureCollection',
            generator: 'ERLC Road Network Studio',
            calibration: this.calibration,
            features
        };
    }

    // Export to Roblox Lua Table format
    toRobloxLua() {
        const pps = this.calibration.pixelsPerStud || 2.0;
        console.log(`[RoadGraph:Export] Generating Roblox Lua table for ${this.nodes.size} nodes and ${this.lanes.size} lanes`);
        let lua = `-- ERLC Road Network Graph generated by Road Network Studio\n`;
        lua += `local RoadNetwork = {\n`;
        lua += `    Nodes = {\n`;
        for (const node of this.nodes.values()) {
            // Convert to studs relative to center or origin
            const xStuds = (node.x / pps).toFixed(2);
            const zStuds = (node.y / pps).toFixed(2);
            lua += `        ["${node.id}"] = { Position = Vector3.new(${xStuds}, 0, ${zStuds}) },\n`;
        }
        lua += `    },\n`;
        lua += `    Lanes = {\n`;
        for (const lane of this.lanes.values()) {
            lua += `        ["${lane.id}"] = {\n`;
            lua += `            Name = "${lane.name.replace(/"/g, '\\"')}",\n`;
            lua += `            SpeedLimit = ${lane.speedLimit},\n`;
            lua += `            Material = "${(lane.material || 'paved').charAt(0).toUpperCase() + (lane.material || 'paved').slice(1)}",\n`;
            lua += `            OneWay = ${lane.oneWay !== false ? 'true' : 'false'},\n`;
            lua += `            StartNode = "${lane.startNodeId}",\n`;
            lua += `            EndNode = "${lane.endNodeId}",\n`;
            lua += `            Waypoints = {\n`;
            for (const wp of lane.waypoints) {
                const wx = (wp.x / pps).toFixed(2);
                const wz = (wp.y / pps).toFixed(2);
                lua += `                Vector3.new(${wx}, 0, ${wz}),\n`;
            }
            lua += `            },\n`;
            lua += `        },\n`;
        }
        lua += `    }\n`;
        lua += `}\n\nreturn RoadNetwork\n`;
        return lua;
    }
}
