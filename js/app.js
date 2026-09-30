/**
 * Main Application Controller for Road Network Studio
 * Coordinates Graph, Renderer, User Input, Shortcuts, Context Menus, and UI Panels.
 */
import { RoadGraph } from './graph.js';
import { RoadRenderer } from './renderer.js';
import { snapAngle, dist } from './math.js';

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

        // Minimap canvas
        this.minimapCanvas = document.getElementById('minimap-canvas');
        this.renderer.onRender = () => this.updateMinimap();

        this.init();
    }

    async init() {
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

        this.currentTool = tool;
        this.connectSourceLaneId = null;

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

            // Handle Dragging Waypoint Handle
            if (this.isDraggingHandle && this.draggedLaneId) {
                const lane = this.graph.lanes.get(this.draggedLaneId);
                if (lane && lane.waypoints[this.draggedHandleIndex]) {
                    lane.waypoints[this.draggedHandleIndex] = { x: world.x, y: world.y };
                    // If moving end or start node, update node position
                    if (this.draggedHandleIndex === 0 && lane.startNodeId) {
                        const node = this.graph.nodes.get(lane.startNodeId);
                        if (node) { node.x = world.x; node.y = world.y; }
                    } else if (this.draggedHandleIndex === lane.waypoints.length - 1 && lane.endNodeId) {
                        const node = this.graph.nodes.get(lane.endNodeId);
                        if (node) { node.x = world.x; node.y = world.y; }
                    }
                    this.renderer.render();
                    return;
                }
            }

            // Snapping Detection (respect active layer)
            const snap = this.graph.findSnapTarget(world, 18 / this.renderer.scale, null, this.currentTool === 'draw' ? this.activeLayer : null);
            this.renderer.snapTarget = snap;

            // Hover detection in Select / Connect modes
            if (this.currentTool === 'select' || this.currentTool === 'connect') {
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

            if (this.isDraggingHandle) {
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
    }

    handleLeftClick(sx, sy, e) {
        this.hideContextMenu();
        let world = this.renderer.screenToWorld(sx, sy);

        // Snap target check
        const snap = this.renderer.snapTarget;

        if (this.currentTool === 'draw') {
            let pointToPlace = { ...world };
            let targetNodeId = null;

            if (snap) {
                pointToPlace = { ...snap.point };
                if (snap.type === 'node') {
                    targetNodeId = snap.node.id;
                } else if (snap.type === 'lane') {
                    // Split the intersected lane or snap to point
                    const newNode = this.graph.findOrCreateNodeAt(snap.point.x, snap.point.y, 8);
                    targetNodeId = newNode.id;
                }
            }

            // If Shift is pressed and we already have a point, snap angle to 45 deg
            if (this.isShiftPressed && this.drawingWaypoints.length > 0) {
                const prev = this.drawingWaypoints[this.drawingWaypoints.length - 1];
                pointToPlace = snapAngle(prev, pointToPlace);
            }

            // First point
            if (this.drawingWaypoints.length === 0) {
                this.drawingWaypoints.push(pointToPlace);
                this.drawingStartNodeId = targetNodeId;
                this.renderer.activeDrawingWaypoints = this.drawingWaypoints;
                this.renderer.render();
                return;
            }

            // Avoid duplicate contiguous points
            const lastPoint = this.drawingWaypoints[this.drawingWaypoints.length - 1];
            if (dist(lastPoint, pointToPlace) < 3) return;

            // Add waypoint
            this.drawingWaypoints.push(pointToPlace);
            this.renderer.activeDrawingWaypoints = this.drawingWaypoints;

            // If clicking on an existing node (that is not the very first node of this lane), finish lane automatically!
            if (targetNodeId && targetNodeId !== this.drawingStartNodeId && this.drawingWaypoints.length >= 2) {
                this.finishDrawing(targetNodeId);
                return;
            }

            this.renderer.render();
        } else if (this.currentTool === 'select') {
            // Check if clicking a waypoint handle on the currently selected lane
            if (this.renderer.selectedLaneId) {
                const lane = this.graph.lanes.get(this.renderer.selectedLaneId);
                if (lane) {
                    const handleThreshold = 10 / this.renderer.scale;
                    for (let i = 0; i < lane.waypoints.length; i++) {
                        if (dist(world, lane.waypoints[i]) <= handleThreshold) {
                            this.isDraggingHandle = true;
                            this.draggedHandleIndex = i;
                            this.draggedLaneId = lane.id;
                            return;
                        }
                    }
                }
            }

            // Select node or lane
            if (snap && snap.type === 'node') {
                this.selectNode(snap.node.id);
            } else if (snap && snap.type === 'lane') {
                this.selectLane(snap.lane.id);
            } else {
                this.clearSelection();
            }
        } else if (this.currentTool === 'connect') {
            if (snap && snap.type === 'lane') {
                if (!this.connectSourceLaneId) {
                    this.connectSourceLaneId = snap.lane.id;
                    this.showToast(`Selected source lane: ${snap.lane.name}. Now click target lane.`, 'info');
                } else if (this.connectSourceLaneId !== snap.lane.id) {
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
                this.openContextMenu(e.clientX, e.clientY, snap.lane);
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
            this.showToast(`Created ${displayName} with ${lane.waypoints.length} waypoints`, 'success');
            this.selectLane(lane.id);
        } catch (err) {
            this.showToast(err.message, 'error');
        }

        this.drawingWaypoints = [];
        this.drawingStartNodeId = null;
        this.renderer.activeDrawingWaypoints = [];
        this.renderer.render();
    }

    cancelDrawing() {
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
        this.showInspectorForLane(lane);
        this.renderer.render();
    }

    selectNode(nodeId) {
        this.renderer.selectedNodeId = nodeId;
        this.renderer.selectedNodeIds.clear();
        this.renderer.selectedLaneId = null;
        this.renderer.selectedLaneIds.clear();
        const node = this.graph.nodes.get(nodeId);
        this.showInspectorForNode(node);
        this.renderer.render();
    }

    clearSelection() {
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
        this.graph.reverseLane(laneId);
        this.showToast('Reversed lane direction', 'success');
        const lane = this.graph.lanes.get(laneId);
        this.showInspectorForLane(lane);
    }

    deleteSelected() {
        if (this.renderer.selectedLaneId) {
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
                this.setTool('draw');
            } else if (e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'v') {
                this.setTool('select');
            } else if (e.key.toLowerCase() === 'c') {
                this.setTool('connect');
            }

            // Parallel duplicate shortcut
            if (e.key.toLowerCase() === 'd') {
                e.preventDefault();
                this.duplicateSelectedLane(24, false);
            }

            // Tab toggles between blank and postals map
            if (e.key === 'Tab') {
                e.preventDefault();
                this.toggleMapLayer();
            }

            // Delete / Backspace
            if (e.key === 'Delete' || e.key === 'Backspace') {
                this.deleteSelected();
            }

            // Escape
            if (e.key === 'Escape') {
                if (this.currentTool === 'draw' && this.drawingWaypoints.length > 0) {
                    this.cancelDrawing();
                } else {
                    this.clearSelection();
                    this.hideContextMenu();
                }
            }

            // Fit view (F)
            if (e.key.toLowerCase() === 'f') {
                this.renderer.fitView();
            }

            // Help Modal (H or ?)
            if (e.key.toLowerCase() === 'h' || e.key === '?') {
                this.toggleModal('shortcuts-modal');
            }

            // Undo / Redo
            if (e.ctrlKey || e.metaKey) {
                if (e.key.toLowerCase() === 'z') {
                    e.preventDefault();
                    if (e.shiftKey) {
                        this.graph.redo();
                        this.showToast('Redo', 'info');
                    } else {
                        this.graph.undo();
                        this.showToast('Undo', 'info');
                    }
                } else if (e.key.toLowerCase() === 'y') {
                    e.preventDefault();
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
                this.renderer.render();
            });
        }

        // Map Layer Toggles
        document.getElementById('toggle-arrows')?.addEventListener('change', (e) => {
            this.renderer.showArrows = e.target.checked;
            this.renderer.render();
        });
        document.getElementById('toggle-nodes')?.addEventListener('change', (e) => {
            this.renderer.showNodes = e.target.checked;
            this.renderer.render();
        });
        document.getElementById('toggle-grid')?.addEventListener('change', (e) => {
            this.renderer.showGrid = e.target.checked;
            this.renderer.render();
        });

        // Action Buttons
        document.getElementById('btn-undo')?.addEventListener('click', () => this.graph.undo());
        document.getElementById('btn-redo')?.addEventListener('click', () => this.graph.redo());
        document.getElementById('btn-fit')?.addEventListener('click', () => this.renderer.fitView());
        document.getElementById('btn-export')?.addEventListener('click', () => this.openExportModal());
        document.getElementById('btn-import')?.addEventListener('click', () => this.triggerImport());
        document.getElementById('btn-clear')?.addEventListener('click', () => {
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
            if (this.renderer.selectedLaneId) {
                this.graph.updateLane(this.renderer.selectedLaneId, { name: e.target.value });
            }
        });
        document.getElementById('inspector-speed')?.addEventListener('input', (e) => {
            const spd = parseInt(e.target.value, 10);
            if (!isNaN(spd)) {
                this.activeSpeedLimit = spd;
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

        // Setup File Upload Input for Import
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    this.graph.deserialize(event.target.result);
                    this.showToast('Road network imported successfully!', 'success');
                } catch (err) {
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

        // Minimap Toggle & Pan Interaction
        document.getElementById('minimap-toggle')?.addEventListener('click', () => {
            const body = document.getElementById('minimap-body');
            body?.classList.toggle('collapsed');
            const icon = document.querySelector('#minimap-toggle svg');
            if (icon) {
                icon.style.transform = body?.classList.contains('collapsed') ? 'rotate(180deg)' : 'rotate(0deg)';
            }
        });

        const minimap = document.getElementById('minimap-canvas');
        if (minimap) {
            const panFromMinimap = (e) => {
                const rect = minimap.getBoundingClientRect();
                const mx = e.clientX - rect.left;
                const my = e.clientY - rect.top;
                const worldX = (mx / minimap.width) * 5355;
                const worldY = (my / minimap.height) * 5355;

                const dpr = this.renderer.dpr || 1;
                const screenW = this.canvas.width / dpr;
                const screenH = this.canvas.height / dpr;

                this.renderer.offsetX = (screenW / 2) - worldX * this.renderer.scale;
                this.renderer.offsetY = (screenH / 2) - worldY * this.renderer.scale;
                this.renderer.render();
            };

            let isMinimapDown = false;
            minimap.addEventListener('mousedown', (e) => {
                isMinimapDown = true;
                panFromMinimap(e);
            });
            window.addEventListener('mousemove', (e) => {
                if (isMinimapDown) panFromMinimap(e);
            });
            window.addEventListener('mouseup', () => {
                isMinimapDown = false;
            });
        }

        // Smooth Spline Checkbox
        document.getElementById('inspector-smooth')?.addEventListener('change', (e) => {
            this.activeSmooth = e.target.checked;
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
            for (const laneId of this.renderer.selectedLaneIds) {
                this.graph.updateLane(laneId, { speedLimit: spd });
            }
            this.showToast(`Updated speed to ${spd} MPH for ${this.renderer.selectedLaneIds.size} lanes`, 'success');
        });

        document.getElementById('btn-multi-delete')?.addEventListener('click', () => {
            const laneCount = this.renderer.selectedLaneIds.size;
            const nodeCount = this.renderer.selectedNodeIds.size;
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

    openContextMenu(x, y, lane) {
        const menu = document.getElementById('context-menu');
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.classList.add('active');

        menu.innerHTML = `
            <div class="menu-header">${lane.name} (${lane.speedLimit} MPH)</div>
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
            <div class="menu-item" id="ctx-highway">
                <re-icon icon="map-point" size="15"></re-icon>
                <span>Mark as Highway</span>
            </div>
            <div class="menu-item" id="ctx-delete" style="color: var(--error);">
                <re-icon icon="trash" size="15"></re-icon>
                <span>Delete Lane</span>
            </div>
        `;

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
        document.getElementById('ctx-highway')?.addEventListener('click', () => {
            this.graph.updateLane(lane.id, { laneType: 'highway', speedLimit: 65 });
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
        if (laneFields) laneFields.style.display = 'block';
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
        if (nodeFields) nodeFields.style.display = 'block';
        if (topoGroup) topoGroup.style.display = 'block';

        const nodeIdDisplay = document.getElementById('inspector-node-id-display');
        if (nodeIdDisplay) nodeIdDisplay.value = node.id;

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

    // Floating Minimap updater
    updateMinimap() {
        if (!this.minimapCanvas) return;
        this.renderer.renderMinimap(this.minimapCanvas);
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

        const route = this.graph.findRoute(startId, targetId, { emergency });
        if (!route.found) {
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

        this.showToast(`Route calculated: ${route.totalDistanceStuds} studs (${route.instructions.length} steps)`, 'success');
    }

    clearActiveRoute() {
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
        this.toggleModal('diagnostics-modal');
        this.runDiagnosticsAudit();
        this.refreshIcons();
    }

    runDiagnosticsAudit() {
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
                    this.showToast('Jumped to issue location', 'info');
                });

                listEl.appendChild(row);
            });
        }

        document.getElementById('badge-orphans').textContent = `${orphans} Disconnected`;
        document.getElementById('badge-duplicates').textContent = `${duplicates} Near-Duplicates`;
        document.getElementById('badge-deadends').textContent = `${deadends} Dead Ends`;
        this.refreshIcons();
    }

    autoMergeNearVertices() {
        const tol = parseFloat(document.getElementById('diag-merge-tol')?.value) || 4;
        const res = this.graph.mergeNearNodes(tol);
        this.runDiagnosticsAudit();
        this.renderer.render();
        this.showToast(`Merged ${res.mergedCount} redundant vertices (tolerance: ${tol} studs)`, 'success');
    }

    // Procedural Generator Methods
    openGeneratorModal() {
        this.toggleModal('generator-modal');
        this.refreshIcons();
    }

    switchGeneratorTab(tab) {
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
        } catch (err) {
            console.warn('Autosave failed:', err);
        }
    }

    loadAutosave() {
        try {
            const saved = localStorage.getItem('erlc_road_graph_autosave');
            if (saved) {
                this.graph.deserialize(saved, false);
                console.log('Restored road graph from autosave.');
            }
        } catch (err) {
            console.warn('Could not load autosave:', err);
        }
    }

    showToast(message, type = 'info') {
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
