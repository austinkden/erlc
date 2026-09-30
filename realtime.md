# Real-Time Collaborative Road Mapping Architecture (100% Free)

This document details how to implement **Google Docs-style real-time multi-user collaboration** for **ERLC Road Studio** with **zero hosting costs**, **zero paid APIs**, and **no monthly fees**.

---

## 1. Executive Summary & Architecture Overview

To achieve seamless, conflict-free collaborative editing where multiple map editors can draw, edit roads, adjust speed limits, and drag vertices simultaneously without clobbering each other's work, we combine two proven, zero-cost technologies:

1. **Yjs (CRDT)**: High-performance Conflict-Free Replicated Data Type engine designed specifically for collaborative editors. It guarantees that regardless of network latency, packet reordering, or concurrent edits, all connected peers will converge to the exact same road graph state.
2. **WebRTC DataChannels + Free Public Signaling (`y-webrtc`)**: Direct browser-to-browser peer mesh connections that bypass expensive backend application servers entirely. Traffic flows directly between users with near-zero latency (<25ms).

```
                      ┌────────────────────────────────────────┐
                      │ Free Public STUN (Google / Cloudflare) │
                      │       stun.l.google.com:19302          │
                      └──────────────────┬─────────────────────┘
                                         │ (NAT Traversal)
                   ┌─────────────────────┴─────────────────────┐
                   ▼                                           ▼
┌──────────────────────────────────────┐     P2P DataChannel     ┌──────────────────────────────────────┐
│            Browser Peer A            │ ◄─────────────────────► │            Browser Peer B            │
│  - Yjs Document (Lanes & Nodes Map)  │   (Encrypted WebRTC)    │  - Yjs Document (Lanes & Nodes Map)  │
│  - Awareness (Live Cursor / Selection)│                         │  - Awareness (Live Cursor / Selection)│
│  - Local ERLC Canvas Renderer        │                         │  - Local ERLC Canvas Renderer        │
└──────────────────────────────────────┘                         └──────────────────────────────────────┘
                   ▲                                           ▲
                   │                Room Matchmaking           │
                   └─────────────────────┬─────────────────────┘
                                         ▼
                      ┌────────────────────────────────────────┐
                      │    Free Community Signaling Relay      │
                      │    (signaling.yjs.dev / PeerJS Cloud)  │
                      └────────────────────────────────────────┘
```

---

## 2. Zero-Cost Infrastructure Breakdown

All components required for this architecture are **100% free forever**:

| Component | Technology | Free Provider / Tier | Cost |
| :--- | :--- | :--- | :--- |
| **State Synchronization** | Yjs CRDT | Open-Source Client-Side JS | **$0.00** |
| **P2P Transport** | WebRTC DataChannels (`y-webrtc`) | Direct Peer Mesh in Browser | **$0.00** |
| **NAT Traversal (STUN)** | Google Public STUN | `stun:stun.l.google.com:19302` | **$0.00** |
| **Room Signaling** | WebRTC Signaling Server | `wss://signaling.yjs.dev` (Public) or Cloudflare Workers free tier (100k req/day) | **$0.00** |
| **Web Hosting** | Static Site Hosting | GitHub Pages / Cloudflare Pages (Unlimited bandwidth) | **$0.00** |
| **Offline Persistence** | `y-indexeddb` | Client-Side Browser Storage | **$0.00** |

---

## 3. Core Capabilities Provided

### A. Live Collaborative Editing
- **Concurrent Road Creation**: User A can draw Highway 1 while User B maps an intersecting residential cul-de-sac. Both lanes are instantly reconciled and connected.
- **Vertex Snapping Across Peers**: When User A drags an endpoint near User B's new road, the snap ring triggers in real-time.
- **Granular Attribute Sync**: Updating street names, speed limits, materials, and elevation layers synchronizes down to the individual field level without overwriting unrelated properties.

### B. Live Presence & Multi-Cursor Display (Awareness)
- **Colored Peer Cursors**: Each collaborator is assigned a unique palette color with an avatar tag showing their name or patrol unit (e.g. `Officer #41`).
- **Live Selections**: When another user clicks a lane or creates a Shift+Drag marquee selection box, other collaborators see the item highlighted in that user's distinctive color.

### C. Zero-Friction Room Sharing
- **URL Hash Sharing**: Opening `http://.../#room=liberty-county-squad` instantly joins that room's peer network.
- **"Share Session" Button**: Generates a shareable 1-click invitation link.

---

## 4. Implementation Blueprint

### Step 1: Include Yjs and y-webrtc via Free CDN
Add the ES module imports in your application:

```javascript
import * as Y from 'https://esm.sh/yjs@13.6.14';
import { WebrtcProvider } from 'https://esm.sh/y-webrtc@10.3.0';
import { IndexeddbPersistence } from 'https://esm.sh/y-indexeddb@9.0.12';
```

### Step 2: Initialize Yjs Document and Room Provider

```javascript
export class RealtimeCollabManager {
    constructor(graph, renderer) {
        this.graph = graph;
        this.renderer = renderer;

        // 1. Determine Room Name from URL Hash (#room=...)
        const hashParams = new URLSearchParams(window.location.hash.slice(1));
        this.roomName = hashParams.get('room') || 'erlc-default-room';

        // 2. Initialize Shared Yjs Document
        this.ydoc = new Y.Doc();

        // 3. Setup Local Storage Persistence (Offline-First)
        this.indexeddbProvider = new IndexeddbPersistence(this.roomName, this.ydoc);

        // 4. Connect WebRTC P2P Mesh with Public Signaling & STUN
        this.webrtcProvider = new WebrtcProvider(this.roomName, this.ydoc, {
            signaling: [
                'wss://signaling.yjs.dev',
                'wss://y-webrtc-signaling-eu.herokuapp.com'
            ],
            password: null, // Optional room encryption password
            awareness: this.webrtcProvider?.awareness
        });

        // 5. Yjs Shared Collections
        this.yLanes = this.ydoc.getMap('lanes');
        this.yNodes = this.ydoc.getMap('nodes');

        this.initSync();
        this.initAwareness();
    }

    initSync() {
        // Sync incoming remote changes from peers into local RoadGraph
        this.yLanes.observe((event) => {
            event.changes.keys.forEach((change, laneId) => {
                if (change.action === 'add' || change.action === 'update') {
                    const laneData = this.yLanes.get(laneId);
                    this.graph.lanes.set(laneId, laneData);
                } else if (change.action === 'delete') {
                    this.graph.lanes.delete(laneId);
                }
            });
            this.renderer.render();
        });

        // Sync local RoadGraph mutations into Yjs Shared Map
        this.graph.subscribe((event, data) => {
            if (event === 'lane_created' || event === 'lane_updated') {
                this.yLanes.set(data.lane.id, data.lane);
            } else if (event === 'lane_deleted') {
                this.yLanes.delete(data.laneId);
            }
        });
    }

    initAwareness() {
        const awareness = this.webrtcProvider.awareness;

        // Assign a random distinctive color & identifier for this user
        const userColors = ['#8859ff', '#38bdf8', '#f59e0b', '#10b981', '#ec4899', '#f97316'];
        const randomColor = userColors[Math.floor(Math.random() * userColors.length)];
        const userId = 'Editor_' + Math.floor(1000 + Math.random() * 9000);

        awareness.setLocalStateField('user', {
            name: userId,
            color: randomColor
        });

        // Broadcast cursor position on mousemove
        window.addEventListener('mousemove', (e) => {
            if (!this.renderer.cursorPos) return;
            awareness.setLocalStateField('cursor', {
                x: this.renderer.cursorPos.x,
                y: this.renderer.cursorPos.y
            });
        });

        // Render remote cursors on canvas
        awareness.on('change', () => {
            const states = Array.from(awareness.getStates().entries());
            this.renderer.remotePeers = states
                .filter(([clientId]) => clientId !== awareness.clientID)
                .map(([_, state]) => state);
            this.renderer.render();
        });
    }
}
```

---

## 5. Free Fallback & Scaling Options

If the public signaling server ever experiences downtime:
1. **Self-Hosted Free Cloudflare Worker**:
   - Cloudflare provides a generous free tier of 100,000 requests/day and WebSockets for Cloudflare Workers.
   - Deploying `y-webrtc-signaling` on a free Cloudflare Worker provides a 100% uptime, zero-maintenance signaling endpoint.
2. **PeerJS Free Cloud**:
   - `0.peerjs.com` is a completely free signaling server for WebRTC mesh communication.
3. **End-to-End Room Encryption**:
   - Setting `password: 'mySecretPass'` in `WebrtcProvider` natively encrypts all road network data end-to-end between peers, ensuring private mapping sessions.

---

## 6. Next Steps for Activation

To enable this in the live editor:
1. Include the `RealtimeCollabManager` in `js/app.js`.
2. Add a `🔗 Share Session` button in the header HUD that copies the current URL with `#room=<uuid>`.
3. Add remote cursor rendering inside `js/renderer.js` (`this.renderRemoteCursors(ctx)`).
