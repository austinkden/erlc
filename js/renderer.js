/**
 * High Performance Canvas Renderer for Road Network Studio
 * Supports 5355x5355 background maps, viewport pan/zoom, directional arrows,
 * junctions, snap highlights, and lane selection.
 */
import { dist, normalize } from './math.js';

export class RoadRenderer {
    constructor(canvas, graph) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });
        this.graph = graph;

        // Viewport Transform
        this.scale = 0.2; // Start zoomed out to see a good chunk of the 5355x5355 map
        this.offsetX = 0;
        this.offsetY = 0;
        this.minScale = 0.05;
        this.maxScale = 6.0;

        // Images
        this.images = {
            blank: null,
            postals: null
        };
        this.activeMap = 'blank'; // 'blank', 'postals', or 'blend'
        this.postalsOpacity = 0.0; // 0.0 = pure blank, 1.0 = pure postals

        // Display Toggles
        this.showBackground = true;
        this.showArrows = true;
        this.showNodes = true;
        this.showGrid = true;
        this.showConnectors = true;

        // Visual Interaction States
        this.hoveredLaneId = null;
        this.selectedLaneId = null;
        this.selectedLaneIds = new Set();
        this.hoveredNodeId = null;
        this.selectedNodeId = null;
        this.selectedNodeIds = new Set();
        this.snapTarget = null;
        this.activeDrawingWaypoints = [];
        this.cursorPos = null;

        // New feature states: Active Route Overlay & Selection Marquee Box
        this.activeRoute = null;
        this.marqueeBox = null; // { minX, minY, maxX, maxY }

        // Animation loop for smooth chevron arrows & glowing snaps
        this.animTime = 0;
        this.initResizeListener();
    }

    initResizeListener() {
        const resize = () => {
            const dpr = window.devicePixelRatio || 1;
            const w = this.canvas.parentElement.clientWidth;
            const h = this.canvas.parentElement.clientHeight;

            this.canvas.width = Math.floor(w * dpr);
            this.canvas.height = Math.floor(h * dpr);
            this.canvas.style.width = `${w}px`;
            this.canvas.style.height = `${h}px`;

            this.dpr = dpr;
            this.render();
        };

        window.addEventListener('resize', resize);
        setTimeout(resize, 50);
    }

    async loadImages() {
        const loadImg = (src) => new Promise((resolve) => {
            const img = new Image();
            img.src = src;
            img.onload = () => resolve(img);
            img.onerror = () => {
                console.warn(`Could not load map image from ${src}`);
                resolve(null);
            };
        });

        this.images.blank = await loadImg('resources/maps/blank.png');
        this.images.postals = await loadImg('resources/maps/postals.png');

        // Center map initially if loaded
        if (this.images.blank) {
            const cw = this.canvas.parentElement.clientWidth;
            const ch = this.canvas.parentElement.clientHeight;
            const imgW = this.images.blank.naturalWidth || 5355;
            const imgH = this.images.blank.naturalHeight || 5355;

            // Fit nicely
            this.scale = Math.min(cw / imgW, ch / imgH) * 1.05;
            this.offsetX = (cw - imgW * this.scale) / 2;
            this.offsetY = (ch - imgH * this.scale) / 2;
        }

        this.render();
    }

    // Coordinate Transformations
    screenToWorld(screenX, screenY) {
        return {
            x: (screenX - this.offsetX) / this.scale,
            y: (screenY - this.offsetY) / this.scale
        };
    }

    worldToScreen(worldX, worldY) {
        return {
            x: worldX * this.scale + this.offsetX,
            y: worldY * this.scale + this.offsetY
        };
    }

    // Zoom centered on a specific screen point (mouse cursor)
    zoomAt(screenX, screenY, factor) {
        const oldScale = this.scale;
        const newScale = Math.max(this.minScale, Math.min(this.maxScale, oldScale * factor));
        if (newScale === oldScale) return;

        // Keep the world point under the cursor constant
        const world = this.screenToWorld(screenX, screenY);
        this.scale = newScale;
        this.offsetX = screenX - world.x * newScale;
        this.offsetY = screenY - world.y * newScale;

        this.render();
    }

    pan(dx, dy) {
        this.offsetX += dx;
        this.offsetY += dy;
        this.render();
    }

    fitView(contentBBox = null) {
        const cw = this.canvas.parentElement.clientWidth;
        const ch = this.canvas.parentElement.clientHeight;
        const imgW = this.images.blank ? this.images.blank.naturalWidth : 5355;
        const imgH = this.images.blank ? this.images.blank.naturalHeight : 5355;

        this.scale = Math.min(cw / imgW, ch / imgH) * 0.95;
        this.offsetX = (cw - imgW * this.scale) / 2;
        this.offsetY = (ch - imgH * this.scale) / 2;
        this.render();
    }

    render() {
        const ctx = this.ctx;
        const dpr = this.dpr || 1;
        const width = this.canvas.width / dpr;
        const height = this.canvas.height / dpr;

        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Deep dark purple canvas background per astrong.xyz palette (#121016)
        ctx.fillStyle = '#121016';
        ctx.fillRect(0, 0, width, height);

        // Apply World Transform
        ctx.save();
        ctx.translate(this.offsetX, this.offsetY);
        ctx.scale(this.scale, this.scale);

        // 1. Render Map Images
        if (this.showBackground) {
            this.renderBackgroundMap(ctx);
        }

        // 2. Render World Grid (when zoomed in)
        if (this.showGrid) {
            this.renderWorldGrid(ctx, width, height);
        }

        // 3. Render Connectors (lane changes / merges)
        if (this.showConnectors) {
            this.renderConnectors(ctx);
        }

        // 4. Render Road Lanes
        this.renderLanes(ctx);

        // 5. Render Active Drawing Polyline Preview
        this.renderDrawingPreview(ctx);

        // 6. Render Junction Nodes
        if (this.showNodes) {
            this.renderNodes(ctx);
        }

        // 7. Render Snap Ring Highlight
        if (this.snapTarget) {
            this.renderSnapIndicator(ctx);
        }

        // 7b. Render Active Simulated Route
        if (this.activeRoute) {
            this.renderActiveRoute(ctx);
        }

        // 7c. Render Selection Marquee Box
        if (this.marqueeBox) {
            this.renderMarqueeBox(ctx);
        }

        ctx.restore(); // Restore world transform

        // 8. Render Screen-space Overlays (Compass, Scale Bar)
        this.renderScreenOverlays(ctx, width, height);

        ctx.restore();

        if (this.onRender) {
            this.onRender();
        }
    }

    renderBackgroundMap(ctx) {
        const imgW = 5355;
        const imgH = 5355;

        // Subtle boundary border for the map (#1d1b20)
        ctx.fillStyle = '#1d1b20';
        ctx.fillRect(-4, -4, imgW + 8, imgH + 8);

        if (this.images.blank && this.images.blank.complete) {
            ctx.globalAlpha = 1.0;
            ctx.drawImage(this.images.blank, 0, 0, imgW, imgH);
        }

        if (this.images.postals && this.images.postals.complete && this.postalsOpacity > 0.01) {
            ctx.globalAlpha = this.postalsOpacity;
            ctx.drawImage(this.images.postals, 0, 0, imgW, imgH);
            ctx.globalAlpha = 1.0;
        }

        // Map Border (Outline)
        ctx.strokeStyle = '#49454f';
        ctx.lineWidth = 4 / this.scale;
        ctx.strokeRect(0, 0, imgW, imgH);
    }

    renderWorldGrid(ctx, screenW, screenH) {
        // Only show grid when sufficiently zoomed in
        if (this.scale < 0.25) return;

        const pps = this.graph.calibration.pixelsPerStud || 2.0;
        const studStep = this.scale > 1.2 ? 50 : 200; // 50 or 200 studs
        const step = studStep * pps;

        // Calculate visible world bounding box
        const topLeft = this.screenToWorld(0, 0);
        const bottomRight = this.screenToWorld(screenW, screenH);

        const startX = Math.floor(Math.max(0, topLeft.x) / step) * step;
        const endX = Math.min(5355, bottomRight.x);
        const startY = Math.floor(Math.max(0, topLeft.y) / step) * step;
        const endY = Math.min(5355, bottomRight.y);

        ctx.save();
        ctx.lineWidth = 1 / this.scale;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';

        ctx.beginPath();
        for (let x = startX; x <= endX; x += step) {
            ctx.moveTo(x, startY);
            ctx.lineTo(x, endY);
        }
        for (let y = startY; y <= endY; y += step) {
            ctx.moveTo(startX, y);
            ctx.lineTo(endX, y);
        }
        ctx.stroke();

        ctx.restore();
    }

    renderLanes(ctx) {
        // Sort lanes by elevation layer: -1 (tunnels) -> 0 (ground) -> 1 (bridge) -> 2 (flyover)
        const sortedLanes = Array.from(this.graph.lanes.values()).sort((a, b) => (a.layer || 0) - (b.layer || 0));

        for (const lane of sortedLanes) {
            const isSelected = lane.id === this.selectedLaneId || (this.selectedLaneIds && this.selectedLaneIds.has(lane.id));
            const isHovered = lane.id === this.hoveredLaneId;
            const pts = this.graph.getEffectiveWaypoints(lane);
            if (!pts || pts.length < 2) continue;

            const layer = lane.layer || 0;

            // Determine colors with material styling
            const mat = lane.material || 'paved';
            let roadColor = '#8859ff'; // Paved: signature purple
            let casingColor = '#1d1b20';
            let lineWidth = 8;
            let isDashed = false;

            if (mat === 'wood') {
                roadColor = '#d97706'; // Wood: timber plank amber
                casingColor = '#451a03';
                lineWidth = 8;
            } else if (mat === 'dirt') {
                roadColor = '#ca8a04'; // Dirt: unpaved earth
                casingColor = '#36240d';
                lineWidth = 7;
                isDashed = true;
            }

            if (isSelected) {
                roadColor = '#ffffff';
                casingColor = '#8859ff';
            } else if (isHovered) {
                roadColor = mat === 'wood' ? '#fbbf24' : mat === 'dirt' ? '#fde047' : '#cbb8ff';
            }

            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            // Tunnel subterranean styling (layer -1)
            if (layer < 0) {
                ctx.globalAlpha = 0.75;
            }

            // 0. Elevated Bridge / Flyover drop shadow & structure casing (layers 1 & 2)
            if (layer > 0) {
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let i = 1; i < pts.length; i++) {
                    ctx.lineTo(pts[i].x, pts[i].y);
                }
                ctx.strokeStyle = '#09080c';
                ctx.lineWidth = (lineWidth + (layer === 2 ? 14 : 9)) / Math.max(0.6, Math.min(2.5, this.scale));
                ctx.stroke();
            }

            // 1. Selection Outline
            if (isSelected) {
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let i = 1; i < pts.length; i++) {
                    ctx.lineTo(pts[i].x, pts[i].y);
                }
                ctx.strokeStyle = '#8859ff';
                ctx.lineWidth = (lineWidth + 8) / Math.max(0.7, Math.min(2.5, this.scale));
                ctx.stroke();
            }

            // 2. Outer Casing
            ctx.beginPath();
            if (layer < 0) {
                // Tunnels have dashed casing
                ctx.setLineDash([8 / this.scale, 4 / this.scale]);
            }
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
                ctx.lineTo(pts[i].x, pts[i].y);
            }
            ctx.strokeStyle = casingColor;
            ctx.lineWidth = (lineWidth + 4) / Math.max(0.6, Math.min(2.5, this.scale));
            ctx.stroke();
            ctx.setLineDash([]);

            // 3. Lane Line
            ctx.beginPath();
            if (isDashed && !isSelected) {
                ctx.setLineDash([12 / this.scale, 4 / this.scale]);
            }
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
                ctx.lineTo(pts[i].x, pts[i].y);
            }
            ctx.strokeStyle = roadColor;
            ctx.lineWidth = lineWidth / Math.max(0.6, Math.min(2.5, this.scale));
            ctx.stroke();
            ctx.setLineDash([]);

            // 4. Directional Chevron Flow Arrows
            if (this.showArrows) {
                this.renderLaneArrows(ctx, pts, roadColor, isSelected, lane.oneWay !== false);
            }

            // 5. Waypoint Handles (when selected - placed at control vertices)
            if (isSelected) {
                this.renderWaypointHandles(ctx, lane.waypoints);
            }

            ctx.restore();
        }
    }

    renderLaneArrows(ctx, pts, color, isSelected, isOneWay = true) {
        const arrowSpacing = 80; // Distance between arrows in world units
        let distAccum = 40;
        let arrowIndex = 0;

        ctx.fillStyle = isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.85)';

        for (let i = 0; i < pts.length - 1; i++) {
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const segDist = dist(p1, p2);
            if (segDist === 0) continue;

            const dir = normalize({ x: p2.x - p1.x, y: p2.y - p1.y });
            let angle = Math.atan2(dir.y, dir.x);

            let d = arrowSpacing - distAccum;
            while (d < segDist) {
                const ax = p1.x + dir.x * d;
                const ay = p1.y + dir.y * d;

                // For two-way roads, alternate chevron direction
                const currentAngle = (!isOneWay && arrowIndex % 2 === 1) ? angle + Math.PI : angle;

                // Draw sleek chevron arrow
                ctx.save();
                ctx.translate(ax, ay);
                ctx.rotate(currentAngle);

                const size = 5 / Math.max(0.7, Math.min(2.0, this.scale));
                ctx.beginPath();
                ctx.moveTo(-size, -size * 0.8);
                ctx.lineTo(size * 1.2, 0);
                ctx.lineTo(-size, size * 0.8);
                ctx.lineTo(-size * 0.4, 0);
                ctx.closePath();
                ctx.fill();

                ctx.restore();
                d += arrowSpacing;
                arrowIndex++;
            }
            distAccum = segDist - (d - arrowSpacing);
        }
    }

    renderWaypointHandles(ctx, pts) {
        const radius = 5 / Math.max(0.7, Math.min(2.0, this.scale));
        for (let i = 0; i < pts.length; i++) {
            ctx.beginPath();
            ctx.arc(pts[i].x, pts[i].y, radius, 0, Math.PI * 2);
            ctx.fillStyle = i === 0 ? '#10b981' : i === pts.length - 1 ? '#ef4444' : '#ffffff';
            ctx.fill();
            ctx.strokeStyle = '#0f172a';
            ctx.lineWidth = 2 / this.scale;
            ctx.stroke();
        }
    }

    renderNodes(ctx) {
        for (const node of this.graph.nodes.values()) {
            const junc = this.graph.getJunctionSummary(node.id);
            const isHovered = node.id === this.hoveredNodeId;
            const isSelected = node.id === this.selectedNodeId || (this.selectedNodeIds && this.selectedNodeIds.has(node.id));

            ctx.save();
            ctx.translate(node.x, node.y);

            const baseRadius = 6 / Math.max(0.6, Math.min(2.0, this.scale));
            let fillColor = '#cac4d0'; // M3 on-surface-variant

            if (junc.isMerge && junc.isDemerge) {
                fillColor = '#8859ff'; // Signature purple
            } else if (junc.isMerge) {
                fillColor = '#f59e0b'; // Amber merge
            } else if (junc.isDemerge) {
                fillColor = '#b388ff'; // Light purple split
            }

            if (isSelected) {
                fillColor = '#ffffff';
                ctx.strokeStyle = '#8859ff';
            } else if (isHovered) {
                ctx.strokeStyle = '#8859ff';
            } else {
                ctx.strokeStyle = '#1d1b20';
            }

            ctx.lineWidth = 2 / this.scale;

            if (junc.isMerge || junc.isDemerge) {
                // Draw Diamond for junctions / merges / demerges
                const r = baseRadius * 1.3;
                ctx.beginPath();
                ctx.moveTo(0, -r);
                ctx.lineTo(r, 0);
                ctx.lineTo(0, r);
                ctx.lineTo(-r, 0);
                ctx.closePath();
                ctx.fillStyle = fillColor;
                ctx.fill();
                ctx.stroke();
            } else {
                // Circle for regular waypoints
                ctx.beginPath();
                ctx.arc(0, 0, baseRadius, 0, Math.PI * 2);
                ctx.fillStyle = fillColor;
                ctx.fill();
                ctx.stroke();
            }

            ctx.restore();
        }
    }

    renderConnectors(ctx) {
        for (const conn of this.graph.connectors.values()) {
            const fromLane = this.graph.lanes.get(conn.fromLaneId);
            const toLane = this.graph.lanes.get(conn.toLaneId);
            if (!fromLane || !toLane) continue;

            // Midpoint of fromLane to midpoint of toLane
            const fromP = fromLane.waypoints[Math.floor(fromLane.waypoints.length / 2)];
            const toP = toLane.waypoints[Math.floor(toLane.waypoints.length / 2)];

            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([6 / this.scale, 4 / this.scale]);
            ctx.moveTo(fromP.x, fromP.y);
            ctx.lineTo(toP.x, toP.y);
            ctx.strokeStyle = conn.allowed ? '#8859ff' : '#f2b8b5';
            ctx.lineWidth = 3 / Math.max(0.6, Math.min(2.5, this.scale));
            ctx.stroke();

            // Midpoint indicator
            const midX = (fromP.x + toP.x) / 2;
            const midY = (fromP.y + toP.y) / 2;
            ctx.beginPath();
            ctx.arc(midX, midY, 4 / this.scale, 0, Math.PI * 2);
            ctx.fillStyle = conn.allowed ? '#8859ff' : '#f2b8b5';
            ctx.fill();

            ctx.restore();
        }
    }

    renderDrawingPreview(ctx) {
        const pts = this.activeDrawingWaypoints;
        if (!pts || pts.length === 0) return;

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Established points
        if (pts.length > 1) {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
                ctx.lineTo(pts[i].x, pts[i].y);
            }
            ctx.strokeStyle = '#8859ff';
            ctx.lineWidth = 6 / Math.max(0.6, Math.min(2.5, this.scale));
            ctx.stroke();
        }

        // Draw handles for placed points
        const r = 5 / Math.max(0.7, Math.min(2.0, this.scale));
        for (let i = 0; i < pts.length; i++) {
            ctx.beginPath();
            ctx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2);
            ctx.fillStyle = i === 0 ? '#b388ff' : '#8859ff';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2 / this.scale;
            ctx.stroke();
        }

        // Rubber-band line to active cursor or snap target
        const targetPos = this.snapTarget ? this.snapTarget.point : this.cursorPos;
        if (targetPos && pts.length > 0) {
            const last = pts[pts.length - 1];
            ctx.beginPath();
            ctx.setLineDash([8 / this.scale, 6 / this.scale]);
            ctx.moveTo(last.x, last.y);
            ctx.lineTo(targetPos.x, targetPos.y);
            ctx.strokeStyle = '#8859ff';
            ctx.lineWidth = 4 / Math.max(0.6, Math.min(2.5, this.scale));
            ctx.stroke();
        }

        ctx.restore();
    }

    renderSnapIndicator(ctx) {
        const snap = this.snapTarget;
        if (!snap) return;

        ctx.save();
        ctx.translate(snap.point.x, snap.point.y);

        const snapRadius = 14 / Math.max(0.6, Math.min(2.5, this.scale));

        // Outer pulsing ring
        ctx.beginPath();
        ctx.arc(0, 0, snapRadius, 0, Math.PI * 2);
        ctx.strokeStyle = '#8859ff';
        ctx.lineWidth = 2.5 / this.scale;
        ctx.stroke();

        // Inner glowing dot
        ctx.beginPath();
        ctx.arc(0, 0, snapRadius * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = snap.type === 'node' ? '#f59e0b' : '#8859ff';
        ctx.fill();

        ctx.restore();
    }

    renderScreenOverlays(ctx, width, height) {
        // 1. Bottom-Right Scale Indicator Bar
        const pps = this.graph.calibration.pixelsPerStud || 2.0;
        const targetScreenPixels = 120;
        const worldPixels = targetScreenPixels / this.scale;
        const studs = Math.round(worldPixels / pps);

        ctx.save();
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.fillStyle = '#94a3b8';
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 2;

        const barX = width - 160;
        const barY = height - 28;

        ctx.beginPath();
        ctx.moveTo(barX, barY - 4);
        ctx.lineTo(barX, barY);
        ctx.lineTo(barX + targetScreenPixels, barY);
        ctx.lineTo(barX + targetScreenPixels, barY - 4);
        ctx.stroke();

        ctx.fillText(`${studs} studs (${Math.round(worldPixels)} px)`, barX, barY - 8);
        ctx.restore();
    }

    // Render Active Route Path
    renderActiveRoute(ctx) {
        const route = this.activeRoute;
        if (!route || !route.waypoints || route.waypoints.length < 2) return;

        const pts = route.waypoints;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 1. Route Outer Glow / Casing
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.strokeStyle = '#0284c7'; // Deep Sky Blue casing
        ctx.lineWidth = 14 / Math.max(0.6, Math.min(2.5, this.scale));
        ctx.stroke();

        // 2. Main High-contrast Route Line
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.strokeStyle = '#38bdf8'; // Electric Cyan route
        ctx.lineWidth = 8 / Math.max(0.6, Math.min(2.5, this.scale));
        ctx.stroke();

        // 3. Start Point Marker (Green circle with white dot)
        const pStart = pts[0];
        const rStart = 9 / Math.max(0.6, Math.min(2.5, this.scale));
        ctx.beginPath();
        ctx.arc(pStart.x, pStart.y, rStart, 0, Math.PI * 2);
        ctx.fillStyle = '#10b981';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5 / this.scale;
        ctx.stroke();

        // 4. Target Destination Marker (Red pin circle)
        const pEnd = pts[pts.length - 1];
        const rEnd = 10 / Math.max(0.6, Math.min(2.5, this.scale));
        ctx.beginPath();
        ctx.arc(pEnd.x, pEnd.y, rEnd, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5 / this.scale;
        ctx.stroke();

        ctx.restore();
    }

    // Render Box Marquee Selection
    renderMarqueeBox(ctx) {
        const box = this.marqueeBox;
        if (!box) return;

        const x = Math.min(box.startX, box.endX);
        const y = Math.min(box.startY, box.endY);
        const w = Math.abs(box.endX - box.startX);
        const h = Math.abs(box.endY - box.startY);

        ctx.save();
        // Fill with translucent primary purple
        ctx.fillStyle = 'rgba(136, 89, 255, 0.12)';
        ctx.fillRect(x, y, w, h);

        // Dashed outline
        ctx.strokeStyle = '#8859ff';
        ctx.lineWidth = 1.5 / this.scale;
        ctx.setLineDash([6 / this.scale, 4 / this.scale]);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
    }

    // Render Floating Minimap
    renderMinimap(minimapCanvas) {
        if (!minimapCanvas) return;
        const mctx = minimapCanvas.getContext('2d');
        if (!mctx) return;

        const mw = minimapCanvas.width;
        const mh = minimapCanvas.height;
        const mapW = 5355;
        const mapH = 5355;

        mctx.fillStyle = '#121016';
        mctx.fillRect(0, 0, mw, mh);

        const scaleX = mw / mapW;
        const scaleY = mh / mapH;

        // Draw miniature lanes
        mctx.save();
        mctx.scale(scaleX, scaleY);

        mctx.lineWidth = 18;
        mctx.lineCap = 'round';
        mctx.lineJoin = 'round';

        for (const lane of this.graph.lanes.values()) {
            const pts = lane.waypoints;
            if (!pts || pts.length < 2) continue;

            mctx.beginPath();
            mctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
                mctx.lineTo(pts[i].x, pts[i].y);
            }
            mctx.strokeStyle = lane.material === 'wood' ? '#d97706' : lane.material === 'dirt' ? '#ca8a04' : '#8859ff';
            mctx.globalAlpha = 0.65;
            mctx.stroke();
        }
        mctx.restore();

        // Draw Viewport Camera Frustum (current view bounding box)
        const dpr = this.dpr || 1;
        const screenW = this.canvas.width / dpr;
        const screenH = this.canvas.height / dpr;

        const tl = this.screenToWorld(0, 0);
        const br = this.screenToWorld(screenW, screenH);

        const vx = Math.max(0, tl.x * scaleX);
        const vy = Math.max(0, tl.y * scaleY);
        const vw = Math.min(mw - vx, (br.x - tl.x) * scaleX);
        const vh = Math.min(mh - vy, (br.y - tl.y) * scaleY);

        mctx.save();
        mctx.fillStyle = 'rgba(136, 89, 255, 0.2)';
        mctx.fillRect(vx, vy, vw, vh);

        mctx.strokeStyle = '#ffffff';
        mctx.lineWidth = 1.5;
        mctx.strokeRect(vx, vy, vw, vh);
        mctx.restore();
    }
}
