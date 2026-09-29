# COUCH MOVERS

**Live game:** https://couch-movers.couch-movers.workers.dev

A phone-first, real-time multiplayer physics party game for 2-4 players. Every player controls one mover; the authoritative server turns their combined pulls into couch movement and rotation.

The campaign has twelve increasingly difficult jobs: the tutorial hallway, L-corner, fragile living room, Cat Chaos, balcony squeeze, Two-Floor Hoist, Three-Floor Walk-Up, Office Slalom, H-Ladder Heist, Dinner Table Drift, Midnight Zoomies, and the Keyhole Gauntlet. The lobby host can select any stage directly for practice and testing. Every job has a verified clean route around its breakables, while riskier shortcuts remain tempting. Cats reverse course after hitting the couch. The ladder jobs switch to a side view with paired H-shaped ladders, animated climbing legs, visible rungs, floor openings, and rope-only climbing. Couch HP, live scoring, blame, awards, procedural music, impact effects, and worst-crash replay make bad teamwork part of the show.

## Local development

Requirements: Node.js 20+ (Node.js 22 recommended) and npm.

```powershell
npm install
npm run dev
```

The client runs at `http://localhost:5173` and the local authoritative Durable Object runs at `http://localhost:8787`. Vite proxies `/api` HTTP and WebSocket traffic to the authoritative server, so the browser only needs the client address.

To test from another device on the same Wi-Fi network, open `http://<computer-lan-ip>:5173`. Port `8787` does not need to be reachable from the phone. If the local server must use another port, start the client with `VITE_PROXY_TARGET` set to that server URL.

For the smoothest phone test, build once and use Vite preview instead of the development/HMR client. The preview server uses the same `/api` and WebSocket proxy:

```powershell
npm run build
$env:VITE_PROXY_TARGET="http://127.0.0.1:8787"
npm run preview --workspace @couch-movers/client
```

## Verification

```powershell
npm run typecheck
npm run build
npm run audit:levels
npm run audit:ladder
npm run smoke:ladder
npm run smoke:spawns
npm run smoke:network
npm run smoke
npm run smoke:changed
```

The smoke test expects the server to already be running. Its multiplayer checks cover two- and four-player rooms, authoritative snapshot agreement, grip-spam debouncing, mid-game spectators, reconnect/rejoin, host handoff and explicit exit, wall damage and blame, full tutorial completion, scoring, the twelve-stage campaign count, and the next-level transition. The level audit verifies both a physical route and a no-breakables route through every job, 2–4-player spawn clearance, ladder landing clearance, safe cat patrols, and paired ladder openings. The focused ladder physics audit proves all vertical jobs can be completed by 2- and 4-player crews, while released couches fall and ungripped movers cannot climb.

`smoke:ladder` is the focused live-server regression for all vertical jobs: it checks paired ladder geometry, proves up input is blocked outside a ladder, completes a real upstairs delivery, and verifies that the next-stage result flow starts immediately. `smoke:changed` remains the smaller regression for stage-selection permissions and live couch/cat direction reversal.

`smoke:spawns` starts four-player crews on every affected or newly added stage and lets authoritative physics settle without input. It fails if a mover begins inside scenery, a prop breaks by itself, couch HP drops, or the crew receives a passive item penalty.

`smoke:network` is a focused two-player production-path check. It measures five
seconds of snapshot cadence and payload size and verifies that both clients see
identical couch state on every shared server tick.

## Architecture

- `apps/client`: React, Vite, and PixiJS presentation layer
- `apps/server`: Cloudflare Worker and one Durable Object per room
- `packages/shared`: protocol types, level geometry, and shared constants
- `scripts/smoke.mjs`: multi-client resilience and gameplay integration suite
- `scripts/level-audit.mjs`: collision-space reachability and content validation
- `scripts/rope-physics-audit.mjs`: deterministic 2- and 4-player vertical-ladder simulation
- `scripts/ladder-runtime-smoke.mjs`: focused live authoritative ladder-control regression

Periodic physics recovery checkpoints use Cloudflare's non-blocking Durable
Object write mode, so storage durability does not hold back real-time WebSocket
snapshots. Room creation and lifecycle transitions remain confirmed writes.

## Free production deployment

Production uses one Cloudflare Worker for the static Vite app, HTTP API,
WebSockets, and the authoritative SQLite Durable Object. Keeping everything on
one origin avoids CORS configuration and an extra network hop.

1. Create a free Cloudflare account at `https://dash.cloudflare.com/sign-up`.
2. From this project folder, authorize this computer once:

   ```powershell
   npx wrangler login
   ```

3. Validate the complete production bundle without publishing:

   ```powershell
   npm run deploy:check
   ```

4. Publish and copy the `https://couch-movers.<your-subdomain>.workers.dev`
   address printed by Wrangler:

   ```powershell
   npm run deploy
   ```

Future updates use the same `npm run deploy` command and keep the same public
address. No separate frontend host or environment variable is required.
