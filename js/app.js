/**
 * Main Application Controller for Road Network Studio
 * Coordinates Graph, Renderer, User Input, Shortcuts, Context Menus, and UI Panels.
 */
import { RoadGraph } from './graph.js';
import { RoadRenderer } from './renderer.js';
import { snapAngle, dist, projectPointOnPolyline } from './math.js';

class RoadApp {
    constructor() {
        this.graph = new RoadGraph();
        this.canvas = document.getElementById('map-canvas');
        this.renderer = new RoadRenderer(this.canvas, this.graph);

        // Tool Mode: 'draw' | 'select' | 'connect'
        this.currentTool = 'draw';

        // Drawing state
        this.drawingWaypoints = [];
        this.drawingStartNodeId = null;

        // Interaction states
        this.isPanning = false;
        this.isSpacePressed = false;
        this.isShiftPressed = false;
        this.panStart = { x: 0, y: 0 };
        this.isDraggingHandle = false;
        this.draggedHandleIndex = -1;
        this.draggedLaneId = null;

        // Connect tool state
        this.connectSourceLaneId = null;

        // Default lane settings
        this.activeStreetName = '';
        this.activeSpeedLimit = 45;
        this.activeMaterial = 'paved';
        this.activeOneWay = true;
        this.activeLayer = 0;
        this.activeSmooth = false;
        this.parallelOffsetDistance = 24;

        // Marquee Selection state
        this.isMarqueeSelecting = false;
        this.marqueeStart = null;

        // Node dragging state
        this.isDraggingNode = false;
        this.draggedNodeId = null;

        this.init();
    }

    async init() {
        console.log('[RoadApp:Init] Initializing Road Network Studio...');
        this.setupEventListeners();
        this.setupUI();
        this.setupKeyboardShortcuts();
        this.setupGraphSubscription();

        // Load autosave from LocalStorage if present
        this.loadAutosave();

        // Initialize Lucide icons
        this.refreshIcons();

        // Load map background images
        await this.renderer.loadImages();
        this.updateStats();
        console.log('[RoadApp:Init] Road Network Studio ready! Default tool: ' + this.currentTool);
    }

    setupGraphSubscription() {
        this.graph.subscribe((event, data) => {
            this.renderer.render();
            this.updateStats();
            this.updateUndoRedoButtons();

            if (event === 'lane_created' || event === 'lane_updated' || event === 'lane_deleted' || event === 'graph_loaded') {
                this.saveAutosave();
            }
        });
    }

    setTool(tool) {
        if (this.currentTool === 'draw' && this.drawingWaypoints.length > 0) {
            this.finishDrawing();
        }

        const prevTool = this.currentTool;
        this.currentTool = tool;
        this.connectSourceLaneId = null;
        console.log(`[RoadApp:Tool] Active tool changed: ${prevTool} -> ${tool}`);

        // Update UI buttons
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });

        // Set cursor style
        if (tool === 'draw') {
            this.canvas.style.cursor = 'crosshair';
        } else if (tool === 'select') {
            this.canvas.style.cursor = 'default';
        } else if (tool === 'connect') {
            this.canvas.style.cursor = 'pointer';
        }

        const toolEl = document.getElementById('status-tool');
        if (toolEl) toolEl.textContent = tool.toUpperCase();
        this.renderer.render();
    }

    setupEventListeners() {
        const canvas = this.canvas;

        // Prevent context menu on canvas so right-click is dedicated to controls
        canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.handleRightClick(e);
        });

        // Mouse Down
        canvas.addEventListener('mousedown', (e) => {
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;

            // Middle Click (button === 1) or Left-Click while holding Space triggers panning
            if (e.button === 1 || (e.button === 0 && this.isSpacePressed)) {
                this.isPanning = true;
                this.panStart = { x: e.clientX, y: e.clientY };
                canvas.style.cursor = 'grabbing';
                e.preventDefault();
                return;
            }

            // Box Marquee Drag (Select tool + Shift held down)
            if (e.button === 0 && this.currentTool === 'select' && (this.isShiftPressed || e.shiftKey)) {
                const world = this.renderer.screenToWorld(sx, sy);
                this.isMarqueeSelecting = true;
                this.marqueeStart = world;
                this.renderer.marqueeBox = { startX: world.x, startY: world.y, endX: world.x, endY: world.y };
                console.log(`[RoadApp:Select] Started marquee box selection at (${Math.round(world.x)}, ${Math.round(world.y)})`);
                this.renderer.render();
                e.preventDefault();
                return;
            }

            // Left Click (button === 0)
            if (e.button === 0) {
                this.handleLeftClick(sx, sy, e);
            }
        });

        // Mouse Move
        window.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;

            // Handle Panning
            if (this.isPanning) {
                const dx = e.clientX - this.panStart.x;
                const dy = e.clientY - this.panStart.y;
                this.panStart = { x: e.clientX, y: e.clientY };
                this.renderer.pan(dx, dy);
                return;
            }

            const world = this.renderer.screenToWorld(sx, sy);
            this.renderer.cursorPos = world;
            this.updateCursorStatus(world);

            // Handle Marquee Selection Drag
            if (this.isMarqueeSelecting && this.marqueeStart) {
                this.renderer.marqueeBox = {
                    startX: this.marqueeStart.x,
                    startY: this.marqueeStart.y,
                    endX: world.x,
                    endY: world.y
                };
                this.renderer.render();
                return;
            }

            // Handle Dragging Node
            if (this.isDraggingNode && this.draggedNodeId) {
                this.graph.moveNode(this.draggedNodeId, world.x, world.y);
                const countBadge = document.getElementById('inspector-waypoints-count');
                if (countBadge) countBadge.textContent = `Pos: (${Math.round(world.x)}, ${Math.round(world.y)})`;
                const nodeX = document.getElementById('inspector-node-x');
                const nodeY = document.getElementById('inspector-node-y');
                if (nodeX) nodeX.value = Math.round(world.x);
                if (nodeY) nodeY.value = Math.round(world.y);
                canvas.style.cursor = 'move';
                this.renderer.render();
                return;
            }

            // Handle Dragging Waypoint Handle
            if (this.isDraggingHandle && this.draggedLaneId) {
                const lane = this.graph.lanes.get(this.draggedLaneId);
                if (lane && lane.waypoints[this.draggedHandleIndex]) {
                    lane.waypoints[this.draggedHandleIndex] = { x: world.x, y: world.y };
                    // If moving end or start node, update all connected lanes via moveNode
                    if (this.draggedHandleIndex === 0 && lane.startNodeId) {
                        this.graph.moveNode(lane.startNodeId, world.x, world.y);
                    } else if (this.draggedHandleIndex === lane.waypoints.length - 1 && lane.endNodeId) {
                        this.graph.moveNode(lane.endNodeId, world.x, world.y);
                    }
                    this.renderer.render();
                    return;
                }
            }

            // Snapping & Hover detection in Select / Connect modes (never auto-snap or combine in Draw mode)
            if (this.currentTool === 'select' || this.currentTool === 'connect') {
                const snap = this.graph.findSnapTarget(world, 18 / this.renderer.scale);
                this.renderer.snapTarget = snap;
                if (snap && snap.type === 'node') {
                    this.renderer.hoveredNodeId = snap.node.id;
                    this.renderer.hoveredLaneId = null;
                } else if (snap && snap.type === 'lane') {
                    this.renderer.hoveredLaneId = snap.lane.id;
                    this.renderer.hoveredNodeId = null;
                } else {
                    this.renderer.hoveredLaneId = null;
                    this.renderer.hoveredNodeId = null;
                }
            } else {
                this.renderer.snapTarget = null;
                this.renderer.hoveredNodeId = null;
                this.renderer.hoveredLaneId = null;
            }

            // Cursor styling in select mode
            if (this.currentTool === 'select' && !this.isPanning && !this.isSpacePressed && !this.isMarqueeSelecting) {
                if (this.isDraggingNode || (snap && snap.type === 'node')) {
                    canvas.style.cursor = 'move';
                } else if (this.renderer.selectedNodeId) {
                    const selNode = this.graph.nodes.get(this.renderer.selectedNodeId);
                    if (selNode && dist(world, selNode) <= (16 / this.renderer.scale)) {
                        canvas.style.cursor = 'move';
                    } else if (snap && snap.type === 'lane') {
                        canvas.style.cursor = 'pointer';
                    } else {
                        canvas.style.cursor = 'default';
                    }
                } else if (snap && snap.type === 'lane') {
                    canvas.style.cursor = 'pointer';
                } else {
                    canvas.style.cursor = 'default';
                }
            }

            this.renderer.render();
        });

        // Mouse Up
        window.addEventListener('mouseup', (e) => {
            if (this.isPanning && (e.button === 1 || e.button === 0)) {
                this.isPanning = false;
                canvas.style.cursor = this.isSpacePressed ? 'grab' : (this.currentTool === 'draw' ? 'crosshair' : 'default');
            }

            // Finish Marquee Selection
            if (this.isMarqueeSelecting) {
                this.isMarqueeSelecting = false;
                const box = this.renderer.marqueeBox;
                this.renderer.marqueeBox = null;
                if (box) {
                    const minX = Math.min(box.startX, box.endX);
                    const maxX = Math.max(box.startX, box.endX);
                    const minY = Math.min(box.startY, box.endY);
                    const maxY = Math.max(box.startY, box.endY);

                    if (maxX - minX > 5 || maxY - minY > 5) {
                        const { laneIds, nodeIds } = this.graph.selectByBox({ minX, minY, maxX, maxY });
                        this.renderer.selectedLaneIds = new Set(laneIds);
                        this.renderer.selectedNodeIds = new Set(nodeIds);
                        console.log(`[RoadApp:Select] Finished marquee box selection: ${laneIds.length} lane(s), ${nodeIds.length} node(s)`);

                        if (laneIds.length === 1 && nodeIds.length === 0) {
                            this.selectLane(laneIds[0]);
                        } else if (laneIds.length === 0 && nodeIds.length === 1) {
                            this.selectNode(nodeIds[0]);
                        } else if (laneIds.length > 0 || nodeIds.length > 0) {
                            this.showInspectorForMulti(laneIds, nodeIds);
                        } else {
                            this.clearSelection();
                        }
                    }
                }
                this.renderer.render();
            }

            if (this.isDraggingNode) {
                console.log(`[RoadApp:Drag] Completed dragging node ${this.draggedNodeId}`);
                this.isDraggingNode = false;
                this.draggedNodeId = null;
                this.graph.pushHistory();
                this.saveAutosave();
                this.renderer.render();
            }

            if (this.isDraggingHandle) {
                console.log(`[RoadApp:Drag] Completed dragging waypoint handle #${this.draggedHandleIndex + 1} of lane ${this.draggedLaneId}`);
                this.isDraggingHandle = false;
                this.draggedHandleIndex = -1;
                this.draggedLaneId = null;
                this.graph.pushHistory();
                this.saveAutosave();
                this.renderer.render();
            }
        });

        // Scroll Wheel Zoom
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;

            const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
            this.renderer.zoomAt(sx, sy, zoomFactor);
            this.updateZoomStatus();
        }, { passive: false });

        // Double-click to insert waypoint on a lane in Select mode
        canvas.addEventListener('dblclick', (e) => {
            if (this.currentTool !== 'select') return;
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const world = this.renderer.screenToWorld(sx, sy);

            let targetLane = null;
            if (this.renderer.selectedLaneId) {
                targetLane = this.graph.lanes.get(this.renderer.selectedLaneId);
            }
            if (!targetLane) {
                const snap = this.graph.findSnapTarget(world, 20 / this.renderer.scale);
                if (snap && snap.type === 'lane') {
                    targetLane = snap.lane;
                }
            }

            if (targetLane) {
                const res = projectPointOnPolyline(world, targetLane.waypoints);
                if (res && res.dist <= (22 / this.renderer.scale)) {
                    console.log(`[RoadApp:Waypoint] Double-click added waypoint into ${targetLane.id} at index ${res.segmentIndex + 1}`);
                    this.graph.insertWaypoint(targetLane.id, res.segmentIndex + 1, res.point);
                    this.selectLane(targetLane.id);
                    this.saveAutosave();
                    this.renderer.render();
                    this.showToast('Added waypoint to road', 'success');
                }
            }
        });
    }

    handleLeftClick(sx, sy, e) {
        this.hideContextMenu();
        let world = this.renderer.screenToWorld(sx, sy);

        // Snap target check
        const snap = this.renderer.snapTarget;

        if (this.currentTool === 'draw') {
            let pointToPlace = { ...world };

            // If Shift is pressed and we already have a point, snap angle to 45 deg
            if (this.isShiftPressed && this.drawingWaypoints.length > 0) {
                const prev = this.drawingWaypoints[this.drawingWaypoints.length - 1];
                pointToPlace = snapAngle(prev, pointToPlace);
            }

            // First point of lane
            if (this.drawingWaypoints.length === 0) {
                this.drawingWaypoints.push(pointToPlace);
                this.drawingStartNodeId = null;
                this.renderer.activeDrawingWaypoints = this.drawingWaypoints;
                console.log(`[RoadApp:Draw] Started drawing lane at (${Math.round(pointToPlace.x)}, ${Math.round(pointToPlace.y)})`);
                this.renderer.render();
                return;
            }

            // Avoid duplicate contiguous points
            const lastPoint = this.drawingWaypoints[this.drawingWaypoints.length - 1];
            if (dist(lastPoint, pointToPlace) < 3) return;

            // Add waypoint
            this.drawingWaypoints.push(pointToPlace);
            this.renderer.activeDrawingWaypoints = this.drawingWaypoints;
            console.log(`[RoadApp:Draw] Added waypoint #${this.drawingWaypoints.length} at (${Math.round(pointToPlace.x)}, ${Math.round(pointToPlace.y)})`);
            this.renderer.render();
            return;
        } else if (this.currentTool === 'select') {
            // 1. Check if clicking on the currently selected node (or within grab radius)
            if (this.renderer.selectedNodeId) {
                const selNode = this.graph.nodes.get(this.renderer.selectedNodeId);
                const nodeThreshold = 16 / this.renderer.scale;
                if (selNode && dist(world, selNode) <= nodeThreshold) {
                    this.isDraggingNode = true;
                    this.draggedNodeId = selNode.id;
                    this.canvas.style.cursor = 'move';
                    console.log(`[RoadApp:Drag] Started dragging junction node ${selNode.id}`);
                    return;
                }
            }

            // 2. Check if clicking a waypoint handle on the currently selected lane
            if (this.renderer.selectedLaneId) {
                const lane = this.graph.lanes.get(this.renderer.selectedLaneId);
                if (lane) {
                    const handleThreshold = 10 / this.renderer.scale;
                    for (let i = 0; i < lane.waypoints.length; i++) {
                        if (dist(world, lane.waypoints[i]) <= handleThreshold) {
                            this.isDraggingHandle = true;
                            this.draggedHandleIndex = i;
                            this.draggedLaneId = lane.id;
                            console.log(`[RoadApp:Drag] Started dragging waypoint handle #${i + 1} of lane ${lane.id}`);
                            return;
                        }
                    }
                }
            }

            // 3. Select node (and start dragging immediately) or lane
            if (snap && snap.type === 'node') {
                this.selectNode(snap.node.id);
                this.isDraggingNode = true;
                this.draggedNodeId = snap.node.id;
                this.canvas.style.cursor = 'move';
                console.log(`[RoadApp:Drag] Selected & started dragging node ${snap.node.id}`);
                return;
            } else if (snap && snap.type === 'lane') {
                this.selectLane(snap.lane.id);
            } else {
                this.clearSelection();
            }
        } else if (this.currentTool === 'connect') {
            if (snap && snap.type === 'lane') {
                if (!this.connectSourceLaneId) {
                    this.connectSourceLaneId = snap.lane.id;
                    console.log(`[RoadApp:Connect] Selected source lane: ${snap.lane.id}`);
                    this.showToast(`Selected source lane: ${snap.lane.name}. Now click target lane.`, 'info');
                } else if (this.connectSourceLaneId !== snap.lane.id) {
                    console.log(`[RoadApp:Connect] Connecting ${this.connectSourceLaneId} -> ${snap.lane.id}`);
                    const conn = this.graph.addConnector(this.connectSourceLaneId, snap.lane.id, 'lane_change', true);
                    this.showToast('Lane change connector created!', 'success');
                    this.connectSourceLaneId = null;
                }
            }
        }
    }

    handleRightClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const world = this.renderer.screenToWorld(sx, sy);

        if (this.currentTool === 'draw') {
            if (this.drawingWaypoints.length >= 2) {
                this.finishDrawing();
            } else {
                this.cancelDrawing();
            }
            return;
        }

        // Show custom context menu for hovered or selected lane/node
        const snap = this.graph.findSnapTarget(world, 18 / this.renderer.scale);
        if (snap) {
            if (snap.type === 'lane') {
                this.selectLane(snap.lane.id);
                // Check if right-clicked on an existing waypoint handle
                let clickedWaypointIndex = -1;
                const handleThreshold = 14 / this.renderer.scale;
                for (let i = 0; i < snap.lane.waypoints.length; i++) {
                    if (dist(world, snap.lane.waypoints[i]) <= handleThreshold) {
                        clickedWaypointIndex = i;
                        break;
                    }
                }
                this.openContextMenu(e.clientX, e.clientY, snap.lane, world, clickedWaypointIndex);
            } else if (snap.type === 'node') {
                this.selectNode(snap.node.id);
                this.openNodeContextMenu(e.clientX, e.clientY, snap.node);
            }
        } else {
            this.hideContextMenu();
        }
    }

    finishDrawing(endNodeId = null) {
        if (this.drawingWaypoints.length < 2) {
            this.cancelDrawing();
            return;
        }

        try {
            const lane = this.graph.createLane({
                name: this.activeStreetName,
                speedLimit: this.activeSpeedLimit,
                material: this.activeMaterial,
                oneWay: this.activeOneWay,
                layer: this.activeLayer,
                smooth: this.activeSmooth,
                startNodeId: this.drawingStartNodeId,
                endNodeId: endNodeId,
                waypoints: [...this.drawingWaypoints]
            });

            const displayName = lane.name ? `"${lane.name}"` : 'lane';
            console.log(`[RoadApp:Draw] Successfully completed drawing lane ${lane.id} (${lane.waypoints.length} points)`);
            this.showToast(`Created ${displayName} with ${lane.waypoints.length} waypoints`, 'success');
            this.selectLane(lane.id);
        } catch (err) {
            console.error('[RoadApp:Draw] Error creating lane:', err);
            this.showToast(err.message, 'error');
        }

        this.drawingWaypoints = [];
        this.drawingStartNodeId = null;
        this.renderer.activeDrawingWaypoints = [];
        this.renderer.render();
    }

    cancelDrawing() {
        console.log(`[RoadApp:Draw] Cancelled drawing in-progress polyline (${this.drawingWaypoints.length} points discarded)`);
        this.drawingWaypoints = [];
        this.drawingStartNodeId = null;
        this.renderer.activeDrawingWaypoints = [];
        this.renderer.render();
        this.showToast('Drawing cancelled', 'info');
    }

    selectLane(laneId) {
        this.renderer.selectedLaneId = laneId;
        this.renderer.selectedLaneIds.clear();
        this.renderer.selectedNodeId = null;
        this.renderer.selectedNodeIds.clear();
        const lane = this.graph.lanes.get(laneId);
        console.log(`[RoadApp:Select] Selected lane ${laneId} ("${lane?.name || 'unnamed'}")`);
        this.showInspectorForLane(lane);
        this.renderer.render();
    }

    selectNode(nodeId) {
        this.renderer.selectedNodeId = nodeId;
        this.renderer.selectedNodeIds.clear();
        this.renderer.selectedLaneId = null;
        this.renderer.selectedLaneIds.clear();
        const node = this.graph.nodes.get(nodeId);
        console.log(`[RoadApp:Select] Selected junction node ${nodeId} at (${Math.round(node?.x || 0)}, ${Math.round(node?.y || 0)})`);
        this.showInspectorForNode(node);
        this.renderer.render();
    }

    clearSelection() {
        if (this.renderer.selectedLaneId || this.renderer.selectedNodeId || this.renderer.selectedLaneIds.size > 0 || this.renderer.selectedNodeIds.size > 0) {
            console.log('[RoadApp:Select] Cleared active selection');
        }
        this.renderer.selectedLaneId = null;
        this.renderer.selectedNodeId = null;
        this.renderer.selectedLaneIds.clear();
        this.renderer.selectedNodeIds.clear();
        this.hideInspector();
        this.renderer.render();
    }

    showInspectorForMulti(laneIds, nodeIds) {
        const panel = document.getElementById('inspector-panel');
        if (!panel) return;
        panel.classList.add('active');

        console.log(`[RoadApp:Inspector] Multi-selection inspector active (${laneIds.length} lanes, ${nodeIds.length} nodes)`);
        document.getElementById('inspector-title').textContent = 'Batch Selection';
        document.getElementById('inspector-waypoints-count').textContent = `${laneIds.length} lanes, ${nodeIds.length} nodes`;
        
        // Hide single controls, show multi controls
        const laneFields = document.getElementById('inspector-lane-fields');
        const nodeFields = document.getElementById('inspector-node-fields');
        const topoGroup = document.getElementById('inspector-topology-group');
        if (laneFields) laneFields.style.display = 'none';
        if (nodeFields) nodeFields.style.display = 'none';
        if (topoGroup) topoGroup.style.display = 'none';

        document.getElementById('inspector-single-actions').style.display = 'none';
        document.getElementById('inspector-multi-section').style.display = 'block';
        document.getElementById('inspector-turn-matrix-group').style.display = 'none';
        document.getElementById('inspector-multi-count').textContent = `${laneIds.length + nodeIds.length} items`;
    }

    // Parallel Lane Duplication (Rapid multi-lane workflow)
    duplicateSelectedLane(offsetDistance = null, reverse = false) {
        const laneId = this.renderer.selectedLaneId;
        if (!laneId) {
            this.showToast('Select a lane first to duplicate as parallel lane', 'warning');
            return;
        }

        const offset = offsetDistance !== null ? offsetDistance : this.parallelOffsetDistance;
        console.log(`[RoadApp:Lane] Duplicating lane ${laneId} with offset ${offset}px (reverse: ${reverse})`);
        const newLane = this.graph.duplicateParallelLane(laneId, offset, reverse);

        if (newLane) {
            this.showToast(`Created parallel lane (${reverse ? 'opposite' : 'same'} direction)`, 'success');
            this.selectLane(newLane.id);
        } else {
            this.showToast('Failed to create parallel lane', 'error');
        }
    }

    reverseSelectedLane() {
        const laneId = this.renderer.selectedLaneId;
        if (!laneId) return;
        console.log(`[RoadApp:Lane] Reversing lane ${laneId}`);
        this.graph.reverseLane(laneId);
        this.showToast('Reversed lane direction', 'success');
        const lane = this.graph.lanes.get(laneId);
        this.showInspectorForLane(lane);
    }

    deleteSelected() {
        if (this.renderer.selectedLaneId) {
            console.log(`[RoadApp:Delete] Deleting selected lane ${this.renderer.selectedLaneId}`);
            this.graph.deleteLane(this.renderer.selectedLaneId);
            this.clearSelection();
            this.showToast('Lane deleted', 'info');
        } else if (this.renderer.selectedNodeId) {
            // Delete lanes attached to this node
            const nodeId = this.renderer.selectedNodeId;
            const attachedLanes = [];
            for (const lane of this.graph.lanes.values()) {
                if (lane.startNodeId === nodeId || lane.endNodeId === nodeId) {
                    attachedLanes.push(lane.id);
                }
            }
            console.log(`[RoadApp:Delete] Deleting selected node ${nodeId} and ${attachedLanes.length} attached lane(s)`);
            attachedLanes.forEach(id => this.graph.deleteLane(id));
            this.clearSelection();
            this.showToast(`Node and ${attachedLanes.length} attached lane(s) deleted`, 'info');
        }
    }

    setupKeyboardShortcuts() {
        window.addEventListener('keydown', (e) => {
            // Ignore when typing inside input elements
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            // Spacebar for panning
            if (e.code === 'Space' && !this.isSpacePressed) {
                this.isSpacePressed = true;
                this.canvas.style.cursor = 'grab';
                e.preventDefault();
            }

            // Shift for 45 deg angle locking
            if (e.key === 'Shift') {
                this.isShiftPressed = true;
            }

            // Tool switching
            if (e.key.toLowerCase() === 'r') {
                console.log('[RoadApp:Shortcut] Pressed R -> Switch to Draw Tool');
                this.setTool('draw');
            } else if (e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'v') {
                console.log('[RoadApp:Shortcut] Pressed S/V -> Switch to Select Tool');
                this.setTool('select');
            } else if (e.key.toLowerCase() === 'c') {
                console.log('[RoadApp:Shortcut] Pressed C -> Switch to Connect Tool');
                this.setTool('connect');
            }

            // Parallel duplicate shortcut
            if (e.key.toLowerCase() === 'd') {
                e.preventDefault();
                console.log('[RoadApp:Shortcut] Pressed D -> Duplicate Parallel Lane');
                this.duplicateSelectedLane(24, false);
            }

            // Tab toggles between blank and postals map
            if (e.key === 'Tab') {
                e.preventDefault();
                console.log('[RoadApp:Shortcut] Pressed Tab -> Toggle Map Layer');
                this.toggleMapLayer();
            }

            // Delete / Backspace
            if (e.key === 'Delete' || e.key === 'Backspace') {
                console.log('[RoadApp:Shortcut] Pressed Delete/Backspace');
                this.deleteSelected();
            }

            // Escape
            if (e.key === 'Escape') {
                console.log('[RoadApp:Shortcut] Pressed Escape');
                if (this.currentTool === 'draw' && this.drawingWaypoints.length > 0) {
                    this.cancelDrawing();
                } else {
                    this.clearSelection();
                    this.hideContextMenu();
                }
            }

            // Fit view (F)
            if (e.key.toLowerCase() === 'f') {
                console.log('[RoadApp:Shortcut] Pressed F -> Fit View');
                this.renderer.fitView();
            }

            // Help Modal (H or ?)
            if (e.key.toLowerCase() === 'h' || e.key === '?') {
                console.log('[RoadApp:Shortcut] Pressed H -> Open Shortcuts Modal');
                this.toggleModal('shortcuts-modal');
            }

            // Undo / Redo
            if (e.ctrlKey || e.metaKey) {
                if (e.key.toLowerCase() === 'z') {
                    e.preventDefault();
                    if (e.shiftKey) {
                        console.log('[RoadApp:Shortcut] Pressed Ctrl+Shift+Z -> Redo');
                        this.graph.redo();
                        this.showToast('Redo', 'info');
                    } else {
                        console.log('[RoadApp:Shortcut] Pressed Ctrl+Z -> Undo');
                        this.graph.undo();
                        this.showToast('Undo', 'info');
                    }
                } else if (e.key.toLowerCase() === 'y') {
                    e.preventDefault();
                    console.log('[RoadApp:Shortcut] Pressed Ctrl+Y -> Redo');
                    this.graph.redo();
                    this.showToast('Redo', 'info');
                }
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                this.isSpacePressed = false;
                if (!this.isPanning) {
                    this.canvas.style.cursor = this.currentTool === 'draw' ? 'crosshair' : 'default';
                }
            }
            if (e.key === 'Shift') {
                this.isShiftPressed = false;
            }
        });
    }

    toggleMapLayer() {
        // Toggle opacity: 0.0 -> 1.0 -> 0.5 -> 0.0
        if (this.renderer.postalsOpacity < 0.2) {
            this.renderer.postalsOpacity = 1.0;
            this.showToast('Background: Postals Map (100%)', 'info');
        } else if (this.renderer.postalsOpacity > 0.8) {
            this.renderer.postalsOpacity = 0.5;
            this.showToast('Background: Hybrid Blend (50%)', 'info');
        } else {
            this.renderer.postalsOpacity = 0.0;
            this.showToast('Background: Clean Map (Blank)', 'info');
        }

        console.log(`[RoadApp:Layers] Postals map opacity cycled to ${(this.renderer.postalsOpacity * 100).toFixed(0)}%`);
        const slider = document.getElementById('postals-slider');
        if (slider) slider.value = this.renderer.postalsOpacity * 100;
        this.renderer.render();
    }

    setupUI() {
        // Tool Buttons
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setTool(btn.dataset.tool);
            });
        });

        // Map Opacity Slider
        const slider = document.getElementById('postals-slider');
        if (slider) {
            slider.addEventListener('input', (e) => {
                this.renderer.postalsOpacity = parseFloat(e.target.value) / 100;
                console.log(`[RoadApp:Layers] Postals slider opacity set to ${(this.renderer.postalsOpacity * 100).toFixed(0)}%`);
                this.renderer.render();
            });
        }

        // Map Layer Toggles
        document.getElementById('toggle-arrows')?.addEventListener('change', (e) => {
            this.renderer.showArrows = e.target.checked;
            console.log(`[RoadApp:Layers] Directional arrows: ${e.target.checked}`);
            this.renderer.render();
        });
        document.getElementById('toggle-nodes')?.addEventListener('change', (e) => {
            this.renderer.showNodes = e.target.checked;
            console.log(`[RoadApp:Layers] Junction nodes: ${e.target.checked}`);
            this.renderer.render();
        });
        document.getElementById('toggle-grid')?.addEventListener('change', (e) => {
            this.renderer.showGrid = e.target.checked;
            console.log(`[RoadApp:Layers] Background grid: ${e.target.checked}`);
            this.renderer.render();
        });

        // Action Buttons
        document.getElementById('btn-undo')?.addEventListener('click', () => {
            console.log('[RoadApp:Action] Undo clicked');
            this.graph.undo();
        });
        document.getElementById('btn-redo')?.addEventListener('click', () => {
            console.log('[RoadApp:Action] Redo clicked');
            this.graph.redo();
        });
        document.getElementById('btn-fit')?.addEventListener('click', () => {
            console.log('[RoadApp:Action] Fit view clicked');
            this.renderer.fitView();
        });
        document.getElementById('btn-export')?.addEventListener('click', () => this.openExportModal());
        document.getElementById('btn-import')?.addEventListener('click', () => this.triggerImport());
        document.getElementById('btn-clear')?.addEventListener('click', () => {
            console.log('[RoadApp:Action] Clear network requested');
            if (confirm('Are you sure you want to clear the entire road network?')) {
                this.graph.clear();
                this.clearSelection();
                this.showToast('Road network cleared', 'warning');
            }
        });
        document.getElementById('btn-help')?.addEventListener('click', () => this.toggleModal('shortcuts-modal'));

        // Modal Close Buttons
        document.querySelectorAll('.modal-close, .modal-backdrop').forEach(el => {
            el.addEventListener('click', () => {
                document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
            });
        });

        // Inspector Form Controls
        document.getElementById('inspector-name')?.addEventListener('input', (e) => {
            this.activeStreetName = e.target.value;
            console.log(`[RoadApp:Inspector] Street name input: "${e.target.value}"`);
            if (this.renderer.selectedLaneId) {
                this.graph.updateLane(this.renderer.selectedLaneId, { name: e.target.value });
            }
        });
        document.getElementById('inspector-speed')?.addEventListener('input', (e) => {
            const spd = parseInt(e.target.value, 10);
            if (!isNaN(spd)) {
                this.activeSpeedLimit = spd;
                console.log(`[RoadApp:Inspector] Speed limit input: ${spd} MPH`);
                if (this.renderer.selectedLaneId) {
                    this.graph.updateLane(this.renderer.selectedLaneId, { speedLimit: spd });
                }
            }
        });

        // Initialize Custom CSS Dropdown
        this.setupCustomDropdown();

        // Traffic Flow (One-Way / Two-Way) Toggle
        const setOneWay = (isOneWay) => {
            this.activeOneWay = isOneWay;
            console.log(`[RoadApp:Inspector] Traffic flow toggled: ${isOneWay ? 'One-Way' : 'Two-Way'}`);
            document.getElementById('btn-flow-oneway')?.classList.toggle('active', isOneWay);
            document.getElementById('btn-flow-twoway')?.classList.toggle('active', !isOneWay);
            if (this.renderer.selectedLaneId) {
                this.graph.updateLane(this.renderer.selectedLaneId, { oneWay: isOneWay });
                this.renderer.render();
                this.showToast(`Traffic flow set to ${isOneWay ? 'One-Way' : 'Two-Way'}`, 'info');
            }
        };

        document.getElementById('btn-flow-oneway')?.addEventListener('click', () => setOneWay(true));
        document.getElementById('btn-flow-twoway')?.addEventListener('click', () => setOneWay(false));

        document.getElementById('inspector-reverse')?.addEventListener('click', () => this.reverseSelectedLane());
        document.getElementById('inspector-delete')?.addEventListener('click', () => this.deleteSelected());

        const handleNodeCoordinateChange = () => {
            if (!this.renderer.selectedNodeId) return;
            const xVal = parseFloat(document.getElementById('inspector-node-x')?.value);
            const yVal = parseFloat(document.getElementById('inspector-node-y')?.value);
            if (!isNaN(xVal) && !isNaN(yVal)) {
                console.log(`[RoadApp:Inspector] Setting node ${this.renderer.selectedNodeId} position: (${xVal}, ${yVal})`);
                this.graph.pushHistory();
                this.graph.moveNode(this.renderer.selectedNodeId, xVal, yVal);
                this.saveAutosave();
                this.renderer.render();
                const countBadge = document.getElementById('inspector-waypoints-count');
                if (countBadge) countBadge.textContent = `Pos: (${Math.round(xVal)}, ${Math.round(yVal)})`;
            }
        };
        document.getElementById('inspector-node-x')?.addEventListener('change', handleNodeCoordinateChange);
        document.getElementById('inspector-node-y')?.addEventListener('change', handleNodeCoordinateChange);

        // Setup File Upload Input for Import
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            console.log(`[RoadApp:Import] Selected file: ${file.name} (${file.size} bytes)`);
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    this.graph.deserialize(event.target.result);
                    this.showToast('Road network imported successfully!', 'success');
                } catch (err) {
                    console.error('[RoadApp:Import] Failed to parse JSON:', err);
                    this.showToast('Failed to import JSON: ' + err.message, 'error');
                }
            };
            reader.readAsText(file);
        });
        document.body.appendChild(fileInput);
        this.fileInput = fileInput;

        // Route Simulator Button & Modal
        document.getElementById('btn-route')?.addEventListener('click', () => this.openRouteModal());
        document.getElementById('btn-calculate-route')?.addEventListener('click', () => this.calculateRoute());
        document.getElementById('btn-clear-route')?.addEventListener('click', () => this.clearActiveRoute());

        // Network Diagnostics Button & Modal
        document.getElementById('btn-diagnostics')?.addEventListener('click', () => this.openDiagnosticsModal());
        document.getElementById('btn-run-audit')?.addEventListener('click', () => this.runDiagnosticsAudit());
        document.getElementById('btn-auto-merge')?.addEventListener('click', () => this.autoMergeNearVertices());

        // Procedural Generator Button & Modal
        document.getElementById('btn-generator')?.addEventListener('click', () => this.openGeneratorModal());
        document.getElementById('tab-gen-roundabout')?.addEventListener('click', () => this.switchGeneratorTab('roundabout'));
        document.getElementById('tab-gen-culdesac')?.addEventListener('click', () => this.switchGeneratorTab('culdesac'));
        document.getElementById('btn-generate-junction')?.addEventListener('click', () => this.generateProceduralJunction());

        // Smooth Spline Checkbox
        document.getElementById('inspector-smooth')?.addEventListener('change', (e) => {
            this.activeSmooth = e.target.checked;
            console.log(`[RoadApp:Inspector] Smooth spline toggle: ${e.target.checked}`);
            if (this.renderer.selectedLaneId) {
                this.graph.updateLane(this.renderer.selectedLaneId, { smooth: e.target.checked });
                this.renderer.render();
                this.showToast(`Curved road smoothing ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
            }
        });

        // Elevation Layer Select
        this.setupLayerDropdown();

        // Multi-Select Batch Actions
        document.getElementById('btn-multi-apply-speed')?.addEventListener('click', () => {
            const spd = parseInt(document.getElementById('multi-speed')?.value, 10);
            if (isNaN(spd) || spd <= 0) return;
            console.log(`[RoadApp:Batch] Applying speed ${spd} MPH to ${this.renderer.selectedLaneIds.size} lanes`);
            for (const laneId of this.renderer.selectedLaneIds) {
                this.graph.updateLane(laneId, { speedLimit: spd });
            }
            this.showToast(`Updated speed to ${spd} MPH for ${this.renderer.selectedLaneIds.size} lanes`, 'success');
        });

        document.getElementById('btn-multi-delete')?.addEventListener('click', () => {
            const laneCount = this.renderer.selectedLaneIds.size;
            const nodeCount = this.renderer.selectedNodeIds.size;
            console.log(`[RoadApp:Batch] Deleting ${laneCount} lanes and ${nodeCount} nodes in batch`);
            for (const laneId of this.renderer.selectedLaneIds) {
                this.graph.deleteLane(laneId);
            }
            this.clearSelection();
            this.showToast(`Deleted ${laneCount} lanes and ${nodeCount} nodes`, 'info');
        });
    }

    refreshIcons() {
        // Reicon custom element renders reactively upon DOM insertion
    }

    openContextMenu(x, y, lane, world = null, clickedWaypointIndex = -1) {
        const menu = document.getElementById('context-menu');
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.classList.add('active');

        // Check if right-clicked along segment to offer "Insert Waypoint Here"
        let insertOptionHtml = '';
        let projResult = null;
        if (world && clickedWaypointIndex < 0) {
            projResult = projectPointOnPolyline(world, lane.waypoints);
            if (projResult && projResult.dist <= (24 / this.renderer.scale)) {
                insertOptionHtml = `
                    <div class="menu-item" id="ctx-insert-waypoint">
                        <re-icon icon="plus-circle" size="15"></re-icon>
                        <span>Insert Waypoint Here</span>
                    </div>
                `;
            }
        }

        let removePointHtml = '';
        if (clickedWaypointIndex >= 0 && lane.waypoints.length > 2) {
            removePointHtml = `
                <div class="menu-item" id="ctx-remove-waypoint" style="color: var(--error);">
                    <re-icon icon="trash" size="15"></re-icon>
                    <span>Remove Waypoint #${clickedWaypointIndex + 1}</span>
                </div>
            `;
        }

        const laneDisplayName = lane.name || 'Lane';
        menu.innerHTML = `
            <div class="menu-header">${laneDisplayName} (${lane.speedLimit} MPH)</div>
            ${insertOptionHtml}
            ${removePointHtml}
            <div class="menu-item" id="ctx-reverse">
                <re-icon icon="rotate-right" size="15"></re-icon>
                <span>Reverse Direction</span>
            </div>
            <div class="menu-item" id="ctx-parallel-same">
                <re-icon icon="copy" size="15"></re-icon>
                <span>Duplicate Parallel (Same Dir)</span>
            </div>
            <div class="menu-item" id="ctx-parallel-opp">
                <re-icon icon="transfer-h" size="15"></re-icon>
                <span>Duplicate Parallel (Opposite Dir)</span>
            </div>
            <div class="menu-item" id="ctx-delete" style="color: var(--error);">
                <re-icon icon="trash" size="15"></re-icon>
                <span>Delete Lane</span>
            </div>
        `;

        if (insertOptionHtml) {
            document.getElementById('ctx-insert-waypoint')?.addEventListener('click', () => {
                if (projResult) {
                    this.graph.insertWaypoint(lane.id, projResult.segmentIndex + 1, projResult.point);
                    this.saveAutosave();
                    this.showInspectorForLane(lane);
                    this.renderer.render();
                    this.showToast('Waypoint inserted', 'success');
                }
                this.hideContextMenu();
            });
        }

        if (removePointHtml) {
            document.getElementById('ctx-remove-waypoint')?.addEventListener('click', () => {
                try {
                    this.graph.removeWaypoint(lane.id, clickedWaypointIndex);
                    this.saveAutosave();
                    this.showInspectorForLane(lane);
                    this.renderer.render();
                    this.showToast(`Waypoint #${clickedWaypointIndex + 1} removed`, 'info');
                } catch (err) {
                    this.showToast(err.message, 'error');
                }
                this.hideContextMenu();
            });
        }

        document.getElementById('ctx-reverse')?.addEventListener('click', () => {
            this.reverseSelectedLane();
            this.hideContextMenu();
        });
        document.getElementById('ctx-parallel-same')?.addEventListener('click', () => {
            this.duplicateSelectedLane(24, false);
            this.hideContextMenu();
        });
        document.getElementById('ctx-parallel-opp')?.addEventListener('click', () => {
            this.duplicateSelectedLane(-24, true);
            this.hideContextMenu();
        });
        document.getElementById('ctx-delete')?.addEventListener('click', () => {
            this.deleteSelected();
            this.hideContextMenu();
        });
    }

    openNodeContextMenu(x, y, node) {
        const menu = document.getElementById('context-menu');
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.classList.add('active');

        const junc = this.graph.getJunctionSummary(node.id);
        const typeStr = junc.isMerge ? 'Merge Point' : junc.isDemerge ? 'Demerge/Split Point' : 'Junction Node';

        menu.innerHTML = `
            <div class="menu-header">${typeStr}</div>
            <div class="menu-item" id="ctx-start-lane">
                <re-icon icon="plus-circle" size="15"></re-icon>
                <span>Start New Lane Here</span>
            </div>
            <div class="menu-item" id="ctx-delete-node" style="color: var(--error);">
                <re-icon icon="trash" size="15"></re-icon>
                <span>Delete Node & Roads</span>
            </div>
        `;

        document.getElementById('ctx-start-lane')?.addEventListener('click', () => {
            this.setTool('draw');
            this.drawingStartNodeId = node.id;
            this.drawingWaypoints = [{ x: node.x, y: node.y }];
            this.renderer.activeDrawingWaypoints = this.drawingWaypoints;
            this.renderer.render();
            this.hideContextMenu();
        });
        document.getElementById('ctx-delete-node')?.addEventListener('click', () => {
            this.deleteSelected();
            this.hideContextMenu();
        });
    }

    hideContextMenu() {
        document.getElementById('context-menu')?.classList.remove('active');
    }

    setupCustomDropdown() {
        const select = document.getElementById('inspector-material-select');
        if (!select) return;
        const trigger = select.querySelector('.custom-select-trigger');
        const options = select.querySelectorAll('.custom-option');

        trigger?.addEventListener('click', (e) => {
            e.stopPropagation();
            select.classList.toggle('open');
        });

        options.forEach(opt => {
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                const val = opt.dataset.value;
                this.setInspectorMaterial(val);
                select.classList.remove('open');
            });
        });

        document.addEventListener('click', () => {
            select.classList.remove('open');
        });
    }

    setInspectorMaterial(val) {
        const select = document.getElementById('inspector-material-select');
        if (!select) return;
        select.dataset.value = val;
        const label = select.querySelector('.custom-select-label');
        if (label) {
            label.textContent = val.charAt(0).toUpperCase() + val.slice(1);
        }
        select.querySelectorAll('.custom-option').forEach(opt => {
            const isSel = opt.dataset.value === val;
            opt.classList.toggle('selected', isSel);
            opt.setAttribute('aria-selected', isSel ? 'true' : 'false');
        });

        this.activeMaterial = val;
        console.log(`[RoadApp:Inspector] Material set to "${val}"`);
        if (this.renderer.selectedLaneId) {
            this.graph.updateLane(this.renderer.selectedLaneId, { material: val });
            this.renderer.render();
        }
        this.refreshIcons();
    }

    setupLayerDropdown() {
        const select = document.getElementById('inspector-layer-select');
        if (!select) return;
        const trigger = select.querySelector('.custom-select-trigger');
        const options = select.querySelectorAll('.custom-option');

        trigger?.addEventListener('click', (e) => {
            e.stopPropagation();
            select.classList.toggle('open');
        });

        options.forEach(opt => {
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                const val = parseInt(opt.dataset.value, 10);
                this.setInspectorLayer(val);
                select.classList.remove('open');
            });
        });

        document.addEventListener('click', () => {
            select.classList.remove('open');
        });
    }

    setInspectorLayer(val) {
        const select = document.getElementById('inspector-layer-select');
        if (!select) return;
        select.dataset.value = val;
        const label = select.querySelector('.custom-select-label');
        const nameMap = {
            '-1': '-1 (Tunnel)',
            '0': '0 (Ground)',
            '1': '1 (Bridge)',
            '2': '2 (Flyover)'
        };
        if (label) {
            label.textContent = nameMap[val.toString()] || `${val} (Layer)`;
        }
        select.querySelectorAll('.custom-option').forEach(opt => {
            const isSel = opt.dataset.value === val.toString();
            opt.classList.toggle('selected', isSel);
            opt.setAttribute('aria-selected', isSel ? 'true' : 'false');
        });

        this.activeLayer = val;
        console.log(`[RoadApp:Inspector] Elevation layer set to ${val}`);
        if (this.renderer.selectedLaneId) {
            this.graph.updateLane(this.renderer.selectedLaneId, { layer: val });
            this.renderer.render();
        }
        this.refreshIcons();
    }

    showInspectorForLane(lane) {
        const panel = document.getElementById('inspector-panel');
        if (!lane || !panel) return;
        panel.classList.add('active');

        document.getElementById('inspector-title').textContent = 'Lane Properties';
        document.getElementById('inspector-name').value = lane.name || '';
        document.getElementById('inspector-speed').value = lane.speedLimit !== undefined ? lane.speedLimit : 45;
        this.setInspectorMaterial(lane.material || 'paved');
        this.setInspectorLayer(lane.layer !== undefined ? lane.layer : 0);

        const smoothCheckbox = document.getElementById('inspector-smooth');
        if (smoothCheckbox) smoothCheckbox.checked = !!lane.smooth;

        const isOneWay = lane.oneWay !== false;
        document.getElementById('btn-flow-oneway')?.classList.toggle('active', isOneWay);
        document.getElementById('btn-flow-twoway')?.classList.toggle('active', !isOneWay);

        const juncStart = this.graph.getJunctionSummary(lane.startNodeId);
        const juncEnd = this.graph.getJunctionSummary(lane.endNodeId);

        let junctionInfo = 'Standard Segment';
        if (juncStart.isDemerge) junctionInfo = 'Demerges from Fork';
        if (juncEnd.isMerge) junctionInfo = 'Merges into Junction';

        document.getElementById('inspector-junction-info').textContent = junctionInfo;
        document.getElementById('inspector-waypoints-count').textContent = `${lane.waypoints.length} points`;

        // Visibility toggles
        const laneFields = document.getElementById('inspector-lane-fields');
        const nodeFields = document.getElementById('inspector-node-fields');
        const topoGroup = document.getElementById('inspector-topology-group');
        if (laneFields) laneFields.style.display = 'flex';
        if (nodeFields) nodeFields.style.display = 'none';
        if (topoGroup) topoGroup.style.display = 'block';

        const revBtn = document.getElementById('inspector-reverse');
        if (revBtn) revBtn.style.display = 'inline-flex';
        const delBtn = document.getElementById('inspector-delete');
        if (delBtn) {
            delBtn.title = 'Delete selected lane (Delete)';
            const delSpan = delBtn.querySelector('span');
            if (delSpan) delSpan.textContent = 'Delete';
        }

        document.getElementById('inspector-single-actions').style.display = 'grid';
        document.getElementById('inspector-multi-section').style.display = 'none';
        document.getElementById('inspector-turn-matrix-group').style.display = 'none';

        // Render Waypoints List
        const waypointsList = document.getElementById('inspector-waypoints-list');
        if (waypointsList) {
            waypointsList.innerHTML = '';
            lane.waypoints.forEach((pt, idx) => {
                const row = document.createElement('div');
                row.className = 'waypoint-item-row';

                let tagClass = 'waypoint-tag';
                let tagText = `Pt ${idx + 1}`;
                if (idx === 0) {
                    tagClass += ' endpoint-start';
                    tagText = `Pt 1 (Start)`;
                } else if (idx === lane.waypoints.length - 1) {
                    tagClass += ' endpoint-end';
                    tagText = `Pt ${idx + 1} (End)`;
                }

                const canDelete = lane.waypoints.length > 2;

                row.innerHTML = `
                    <div class="${tagClass}">
                        <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor;"></span>
                        <span>${tagText}</span>
                    </div>
                    <div class="waypoint-coords">(${Math.round(pt.x)}, ${Math.round(pt.y)})</div>
                    ${canDelete ? `
                        <button type="button" class="waypoint-btn-del" title="Remove Waypoint ${idx + 1}">
                            <re-icon icon="trash" size="13"></re-icon>
                        </button>
                    ` : '<span style="width: 24px;"></span>'}
                `;

                if (canDelete) {
                    const delBtn = row.querySelector('.waypoint-btn-del');
                    delBtn?.addEventListener('click', (e) => {
                        e.stopPropagation();
                        try {
                            this.graph.removeWaypoint(lane.id, idx);
                            this.saveAutosave();
                            this.showInspectorForLane(lane);
                            this.renderer.render();
                            this.showToast(`Waypoint #${idx + 1} removed`, 'info');
                        } catch (err) {
                            this.showToast(err.message, 'error');
                        }
                    });
                }

                waypointsList.appendChild(row);
            });
        }
    }

    showInspectorForNode(node) {
        const panel = document.getElementById('inspector-panel');
        if (!node || !panel) return;
        panel.classList.add('active');

        const junc = this.graph.getJunctionSummary(node.id);
        document.getElementById('inspector-title').textContent = 'Junction Node';
        document.getElementById('inspector-junction-info').textContent = 
            `In: ${junc.incomingCount} | Out: ${junc.outgoingCount} (${junc.isMerge ? 'Merge' : ''} ${junc.isDemerge ? 'Demerge' : ''})`;
        document.getElementById('inspector-waypoints-count').textContent = `Pos: (${Math.round(node.x)}, ${Math.round(node.y)})`;

        // Visibility toggles
        const laneFields = document.getElementById('inspector-lane-fields');
        const nodeFields = document.getElementById('inspector-node-fields');
        const topoGroup = document.getElementById('inspector-topology-group');
        if (laneFields) laneFields.style.display = 'none';
        if (nodeFields) nodeFields.style.display = 'flex';
        if (topoGroup) topoGroup.style.display = 'block';

        const nodeIdDisplay = document.getElementById('inspector-node-id-display');
        if (nodeIdDisplay) nodeIdDisplay.value = node.id;

        const nodeX = document.getElementById('inspector-node-x');
        const nodeY = document.getElementById('inspector-node-y');
        if (nodeX) nodeX.value = Math.round(node.x);
        if (nodeY) nodeY.value = Math.round(node.y);

        const revBtn = document.getElementById('inspector-reverse');
        if (revBtn) revBtn.style.display = 'none';
        const delBtn = document.getElementById('inspector-delete');
        if (delBtn) {
            delBtn.title = 'Delete selected junction node (Delete)';
            const delSpan = delBtn.querySelector('span');
            if (delSpan) delSpan.textContent = 'Delete Node';
        }

        document.getElementById('inspector-single-actions').style.display = 'grid';
        document.getElementById('inspector-multi-section').style.display = 'none';

        // Render Turn Restriction Matrix for Junction Node
        const turnGroup = document.getElementById('inspector-turn-matrix-group');
        const turnList = document.getElementById('inspector-turn-matrix-list');
        if (junc.incomingLanes.length > 0 && junc.outgoingLanes.length > 0) {
            turnGroup.style.display = 'block';
            turnList.innerHTML = '';

            for (const inLane of junc.incomingLanes) {
                for (const outLane of junc.outgoingLanes) {
                    const row = document.createElement('div');
                    row.className = 'turn-matrix-row';

                    const inName = inLane.name || `Lane #${inLane.id.slice(-4)}`;
                    const outName = outLane.name || `Lane #${outLane.id.slice(-4)}`;
                    const isAllowed = this.graph.isTurnAllowed(node.id, inLane.id, outLane.id);

                    row.innerHTML = `
                        <span class="turn-matrix-label">
                            <span>${inName}</span>
                            <span style="color: var(--primary);">→</span>
                            <span>${outName}</span>
                        </span>
                        <input type="checkbox" ${isAllowed ? 'checked' : ''} title="Allow or prohibit this turn maneuver">
                    `;

                    const cb = row.querySelector('input');
                    cb.addEventListener('change', (e) => {
                        this.graph.setTurnAllowed(node.id, inLane.id, outLane.id, e.target.checked);
                        this.showToast(`Turn ${inName} → ${outName} ${e.target.checked ? 'allowed' : 'prohibited'}`, 'info');
                    });

                    turnList.appendChild(row);
                }
            }
        } else {
            turnGroup.style.display = 'none';
        }
    }

    // Route Simulator Methods
    openRouteModal() {
        const startSelect = document.getElementById('route-start-node');
        const targetSelect = document.getElementById('route-target-node');
        if (!startSelect || !targetSelect) return;

        startSelect.innerHTML = '';
        targetSelect.innerHTML = '';

        const nodes = Array.from(this.graph.nodes.values());
        if (nodes.length === 0) {
            this.showToast('No road nodes exist yet. Draw some lanes first!', 'warning');
            return;
        }

        nodes.forEach(node => {
            const j = this.graph.getJunctionSummary(node.id);
            const connectedLanes = [...j.incomingLanes, ...j.outgoingLanes];
            const laneNames = Array.from(new Set(connectedLanes.map(l => l.name).filter(Boolean))).join(' / ') || 'Road';
            const label = `Node #${node.id.slice(-4)} (${laneNames})`;

            const opt1 = document.createElement('option');
            opt1.value = node.id;
            opt1.textContent = label;
            startSelect.appendChild(opt1);

            const opt2 = document.createElement('option');
            opt2.value = node.id;
            opt2.textContent = label;
            targetSelect.appendChild(opt2);
        });

        // Preselect different destination if more than 1 node
        if (nodes.length > 1) {
            targetSelect.selectedIndex = 1;
        }

        // If user already selected a node on map, use it as start
        if (this.renderer.selectedNodeId) {
            startSelect.value = this.renderer.selectedNodeId;
        }

        this.toggleModal('route-modal');
        console.log('[RoadApp:RouteSimulator] Route simulator modal opened');
        this.refreshIcons();
    }

    calculateRoute() {
        const startId = document.getElementById('route-start-node')?.value;
        const targetId = document.getElementById('route-target-node')?.value;
        const emergency = document.getElementById('route-emergency-toggle')?.checked;

        if (!startId || !targetId) {
            this.showToast('Select both start and destination nodes', 'warning');
            return;
        }

        console.log(`[RoadApp:RouteSimulator] Calculating route from ${startId} -> ${targetId} (emergency: ${emergency})`);
        const route = this.graph.findRoute(startId, targetId, { emergency });
        if (!route.found) {
            console.warn('[RoadApp:RouteSimulator] Pathfinding failed:', route.error);
            this.showToast(route.error || 'No route found between these junctions', 'error');
            return;
        }

        // Store and render active simulated route
        this.renderer.activeRoute = route;
        this.renderer.render();

        // Populate Route Summary Header
        const summaryBar = document.getElementById('route-summary-bar');
        if (summaryBar) summaryBar.style.display = 'grid';

        const totalSec = route.estimatedTimeSeconds;
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        document.getElementById('route-eta').textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
        document.getElementById('route-dist').textContent = `${route.totalDistanceStuds} studs`;
        document.getElementById('route-lane-count').textContent = route.lanes.length;

        // Populate Turn-by-Turn GPS Step List
        const listEl = document.getElementById('route-instructions-list');
        listEl.innerHTML = '';

        const iconMap = {
            depart: 'compass',
            straight: 'arrow-up',
            slight_right: 'arrow-up-right',
            turn_right: 'arrow-right',
            sharp_right: 'rotate-right',
            slight_left: 'arrow-up-left',
            turn_left: 'arrow-left',
            sharp_left: 'rotate-left',
            u_turn: 'rotate-left',
            arrive: 'location'
        };

        route.instructions.forEach(step => {
            const row = document.createElement('div');
            row.className = 'instruction-row';
            const iconName = iconMap[step.type] || 'gps';
            row.innerHTML = `
                <div class="instruction-icon">
                    <re-icon icon="${iconName}" size="18"></re-icon>
                </div>
                <div class="instruction-text">${step.text}</div>
                <div class="instruction-meta">${step.distanceStuds > 0 ? `${step.distanceStuds} studs` : ''}</div>
            `;
            listEl.appendChild(row);
        });

        console.log(`[RoadApp:RouteSimulator] Route solved successfully: ${route.totalDistanceStuds} studs, ETA ${mins}m ${secs}s, ${route.instructions.length} turn steps`);
        this.showToast(`Route calculated: ${route.totalDistanceStuds} studs (${route.instructions.length} steps)`, 'success');
    }

    clearActiveRoute() {
        console.log('[RoadApp:RouteSimulator] Cleared simulated route');
        this.renderer.activeRoute = null;
        this.renderer.render();
        const summaryBar = document.getElementById('route-summary-bar');
        if (summaryBar) summaryBar.style.display = 'none';
        const listEl = document.getElementById('route-instructions-list');
        if (listEl) {
            listEl.innerHTML = `
                <div style="padding: 24px; text-align: center; color: var(--on-surface-variant); font-size: 13px;">
                    Select a start node and destination node above, then click Find Route.
                </div>
            `;
        }
        this.showToast('Route cleared', 'info');
    }

    // Diagnostics Methods
    openDiagnosticsModal() {
        console.log('[RoadApp:Diagnostics] Diagnostics modal opened');
        this.toggleModal('diagnostics-modal');
        this.runDiagnosticsAudit();
        this.refreshIcons();
    }

    runDiagnosticsAudit() {
        console.log('[RoadApp:Diagnostics] Running network health audit...');
        const issues = this.graph.runAudit();

        let orphans = 0;
        let deadends = 0;
        let duplicates = 0;

        const listEl = document.getElementById('diag-issues-list');
        listEl.innerHTML = '';

        if (issues.length === 0) {
            listEl.innerHTML = `
                <div style="padding: 24px; text-align: center; color: #10b981; font-size: 13px; font-weight: 600;">
                    ✓ Network is healthy! No disconnected nodes, near-duplicate vertices, or dead ends found.
                </div>
            `;
        } else {
            issues.forEach(issue => {
                if (issue.type === 'orphan_node') orphans++;
                if (issue.type === 'dead_end') deadends++;
                if (issue.type === 'near_duplicate') duplicates++;

                const row = document.createElement('div');
                row.className = `issue-item severity-${issue.severity}`;
                row.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-weight: 600; color: var(--on-surface);">${issue.message}</span>
                    </div>
                    <button class="icon-subtle btn-jump-issue" style="padding: 4px 8px; font-size: 11px; background: var(--surface-variant);" title="Focus view on this location">
                        Jump to
                    </button>
                `;

                row.querySelector('.btn-jump-issue').addEventListener('click', () => {
                    const dpr = this.renderer.dpr || 1;
                    const screenW = this.canvas.width / dpr;
                    const screenH = this.canvas.height / dpr;
                    this.renderer.offsetX = (screenW / 2) - issue.coords.x * this.renderer.scale;
                    this.renderer.offsetY = (screenH / 2) - issue.coords.y * this.renderer.scale;
                    this.renderer.render();
                    document.getElementById('diagnostics-modal')?.classList.remove('active');
                    console.log(`[RoadApp:Diagnostics] Jumped to issue coords (${Math.round(issue.coords.x)}, ${Math.round(issue.coords.y)})`);
                    this.showToast('Jumped to issue location', 'info');
                });

                listEl.appendChild(row);
            });
        }

        document.getElementById('badge-orphans').textContent = `${orphans} Disconnected`;
        document.getElementById('badge-duplicates').textContent = `${duplicates} Near-Duplicates`;
        document.getElementById('badge-deadends').textContent = `${deadends} Dead Ends`;
        console.log(`[RoadApp:Diagnostics] Audit summary: ${orphans} orphan(s), ${duplicates} near-duplicate(s), ${deadends} dead end(s)`);
        this.refreshIcons();
    }

    autoMergeNearVertices() {
        const tol = parseFloat(document.getElementById('diag-merge-tol')?.value) || 4;
        console.log(`[RoadApp:Diagnostics] Running vertex auto-merge (tolerance: ${tol} studs)...`);
        const res = this.graph.mergeNearNodes(tol);
        this.runDiagnosticsAudit();
        this.renderer.render();
        this.showToast(`Merged ${res.mergedCount} redundant vertices (tolerance: ${tol} studs)`, 'success');
    }

    // Procedural Generator Methods
    openGeneratorModal() {
        console.log('[RoadApp:Procedural] Procedural generator modal opened');
        this.toggleModal('generator-modal');
        this.refreshIcons();
    }

    switchGeneratorTab(tab) {
        console.log(`[RoadApp:Procedural] Switched junction template to "${tab}"`);
        document.getElementById('tab-gen-roundabout')?.classList.toggle('active', tab === 'roundabout');
        document.getElementById('tab-gen-culdesac')?.classList.toggle('active', tab === 'culdesac');
        document.getElementById('gen-roundabout-fields').style.display = tab === 'roundabout' ? 'block' : 'none';
        document.getElementById('gen-culdesac-fields').style.display = tab === 'culdesac' ? 'block' : 'none';
        this.generatorActiveTab = tab;
    }

    generateProceduralJunction() {
        const dpr = this.renderer.dpr || 1;
        const screenW = this.canvas.width / dpr;
        const screenH = this.canvas.height / dpr;
        const center = this.renderer.screenToWorld(screenW / 2, screenH / 2);
        const speedLimit = parseInt(document.getElementById('gen-speed')?.value, 10) || 25;
        const layer = this.activeLayer || 0;

        if (this.generatorActiveTab === 'culdesac') {
            const bulbRadiusStuds = parseFloat(document.getElementById('gen-culdesac-radius')?.value) || 25;
            const stemLengthStuds = parseFloat(document.getElementById('gen-culdesac-stem')?.value) || 50;
            console.log(`[RoadApp:Procedural] Generating cul-de-sac at view center (${Math.round(center.x)}, ${Math.round(center.y)}) stem: ${stemLengthStuds}, bulb: ${bulbRadiusStuds}`);
            this.graph.createCulDeSac({
                center,
                bulbRadiusStuds,
                stemLengthStuds,
                angleDeg: 0,
                speedLimit,
                material: this.activeMaterial,
                layer
            });
            this.showToast('Created procedural Cul-de-sac at view center!', 'success');
        } else {
            const radiusStuds = parseFloat(document.getElementById('gen-roundabout-radius')?.value) || 35;
            const numArms = parseInt(document.getElementById('gen-roundabout-arms')?.value, 10) || 4;
            console.log(`[RoadApp:Procedural] Generating roundabout at view center (${Math.round(center.x)}, ${Math.round(center.y)}) radius: ${radiusStuds}, arms: ${numArms}`);
            this.graph.createRoundabout({
                center,
                radiusStuds,
                numArms,
                speedLimit,
                material: this.activeMaterial,
                layer
            });
            this.showToast(`Created procedural Roundabout with ${numArms} arms at view center!`, 'success');
        }

        document.getElementById('generator-modal')?.classList.remove('active');
        this.renderer.render();
    }

    hideInspector() {
        document.getElementById('inspector-panel')?.classList.remove('active');
    }

    updateStats() {
        const stats = this.graph.getStats();
        const setIf = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        setIf('stat-lanes', stats.laneCount);
        setIf('stat-nodes', stats.nodeCount);
        setIf('stat-merges', stats.mergesCount);
        setIf('stat-demerges', stats.demergesCount);
        setIf('stat-length', `${stats.totalStuds} studs`);
    }

    updateCursorStatus(worldPos) {
        const pps = this.graph.calibration.pixelsPerStud || 2.0;
        const studsX = Math.round(worldPos.x / pps);
        const studsY = Math.round(worldPos.y / pps);
        document.getElementById('status-coords').textContent = `X: ${Math.round(worldPos.x)} Y: ${Math.round(worldPos.y)} (${studsX}, ${studsY} studs)`;
    }

    updateZoomStatus() {
        const pct = Math.round(this.renderer.scale * 100);
        const zoomEl = document.getElementById('status-zoom');
        if (zoomEl) zoomEl.textContent = `${pct}%`;
    }

    updateUndoRedoButtons() {
        const undoBtn = document.getElementById('btn-undo');
        const redoBtn = document.getElementById('btn-redo');
        if (undoBtn) undoBtn.disabled = !this.graph.canUndo();
        if (redoBtn) redoBtn.disabled = !this.graph.canRedo();
    }

    toggleModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.toggle('active');
        }
    }

    openExportModal() {
        const modal = document.getElementById('export-modal');
        if (!modal) return;
        modal.classList.add('active');
        console.log('[RoadApp:Export] Export modal opened');

        const jsonStr = this.graph.serialize();
        const geoJsonStr = JSON.stringify(this.graph.toGeoJSON(), null, 2);
        const luaStr = this.graph.toRobloxLua();

        document.getElementById('export-json-preview').value = jsonStr;
        document.getElementById('export-geojson-preview').value = geoJsonStr;
        document.getElementById('export-lua-preview').value = luaStr;

        // Download JSON button
        document.getElementById('btn-download-json').onclick = () => {
            this.downloadFile('erlc_road_network.json', jsonStr, 'application/json');
        };
        // Download GeoJSON button
        document.getElementById('btn-download-geojson').onclick = () => {
            this.downloadFile('erlc_road_network.geojson', geoJsonStr, 'application/geo+json');
        };
        // Download Lua button
        document.getElementById('btn-download-lua').onclick = () => {
            this.downloadFile('RoadNetwork.lua', luaStr, 'text/plain');
        };
        this.refreshIcons();
    }

    downloadFile(filename, text, mimeType) {
        console.log(`[RoadApp:Export] Exporting file "${filename}" (${text.length} characters)`);
        const blob = new Blob([text], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.showToast(`Exported ${filename}`, 'success');
    }

    saveAutosave() {
        try {
            const data = this.graph.serialize();
            localStorage.setItem('erlc_road_graph_autosave', data);
            console.log(`[RoadApp:Autosave] Saved graph state (${this.graph.lanes.size} lanes, ${this.graph.nodes.size} nodes)`);
        } catch (err) {
            console.warn('[RoadApp:Autosave] Autosave failed:', err);
        }
    }

    loadAutosave() {
        try {
            const saved = localStorage.getItem('erlc_road_graph_autosave');
            if (saved) {
                this.graph.deserialize(saved, false);
                console.log('[RoadApp:Autosave] Restored road graph from localStorage');
            }
        } catch (err) {
            console.warn('[RoadApp:Autosave] Could not load autosave:', err);
        }
    }

    showToast(message, type = 'info') {
        console.log(`[RoadApp:Toast:${type}] ${message}`);
        const container = document.getElementById('toast-container');
        if (!container) return;

        const iconName = type === 'success' ? 'check-circle' : type === 'warning' ? 'alert-triangle' : type === 'error' ? 'alert-circle' : 'info-circle';

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <re-icon icon="${iconName}" size="16"></re-icon>
            <span>${message}</span>
        `;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 250);
        }, 3200);
    }
}

// Instantiate on DOM load
window.addEventListener('DOMContentLoaded', () => {
    window.app = new RoadApp();
});
