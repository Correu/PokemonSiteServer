# PokemonSiteServer

Authoritative Node.js/Socket.IO battle server for [PokemonSite](https://github.com/Correu/PokemonSite). All game logic — damage calculation, status conditions, type effectiveness, item resolution, and turn ordering — runs here. Clients receive state via `battle:stateUpdate` events; no game-critical logic runs in the browser.

Designed for **self-hosting**: one player runs this server and shares the URL with their opponent. No account, no cloud subscription required.

---

## Self-Hosting for Remote 1v1

This is the primary use case. One player (the host) runs this server on their own machine. Both players connect to it through the Angular app.

### Quick Start

```bash
git clone https://github.com/Correu/PokemonSiteServer
cd PokemonSiteServer
npm install
npm start
# Server is now listening on http://localhost:3000
```

Verify it is running:
```bash
curl http://localhost:3000/health
# { "ok": true }
```

### Making the Server Reachable

The server binds to `0.0.0.0:3000` by default, so it is reachable on your local network. For internet play, choose one of the following:

| Method | Effort | Notes |
| --- | --- | --- |
| **ngrok** (recommended) | Easiest | `ngrok http 3000` → provides an `https://` URL instantly. Free tier is sufficient. |
| **localtunnel** | Easy | `npx localtunnel --port 3000` — no account required. |
| **LAN IP** | Medium | Works if both players are on the same network. Allow inbound TCP 3000 in your OS firewall and use `http://<your-LAN-IP>:3000`. |
| **Router port-forward** | Medium | Forward external TCP 3000 to your machine's LAN IP; share your public IP. |
| **Cloudflare Tunnel** | Medium | Free, stable, provides HTTPS. Requires a Cloudflare account. |

### Connecting from the Angular App

In the battle workspace, enter the server URL in the **Socket.IO URL** field and click **Apply and reconnect**. The URL persists in `localStorage`.

The host can share an **invite link** that embeds both the room code and the server URL — guests who open the link connect and join automatically:

```
https://your-app.example.com/battle?join=<roomCode>&socketUrl=<serverUrl>
```

### HTTPS Mixed Content

If the Angular app is served over **HTTPS** (e.g. via AWS Amplify), browsers block plain `http://` WebSocket connections. Use an HTTPS tunnel (ngrok provides one by default) rather than a bare `http://` IP.

---

## Battle Engine

All combat resolution is handled in `controllers/battle-engine.js`. No accuracy checks, critical hits, abilities, or weather are implemented.

### Damage Formula

```
base    = floor( ((2 × level / 5 + 2) × power × (Atk / Def)) / 50 + 2 )
damage  = max(1, floor(base × variance × STAB × typeMult))
```

- **Physical vs special** determined by move's `damageClass`; burn halves physical Attack.
- **Variance** — random multiplier in `[0.85, 1.00]`.
- **STAB** — 1.5× when the move's type matches one of the attacker's own types.
- **Type multiplier** — product of effectiveness across all of the defender's types (see below).

### Type Effectiveness

Full 18-type chart covering all generations (Normal, Fire, Water, Electric, Grass, Ice, Fighting, Poison, Ground, Flying, Psychic, Bug, Rock, Ghost, Dragon, Dark, Steel, Fairy). Dual-type defenders multiply both lookup values, allowing 4× and 0.25× outcomes.

| Multiplier | Meaning |
| --- | --- |
| 0× | Immune — no damage |
| 0.5× / 0.25× | Not very effective |
| 1× | Neutral |
| 2× / 4× | Super effective |

A message is appended to the turn log after each damaging move: "It's super effective!", "It's not very effective...", or "It doesn't affect [name]..." for immunities.

### Status Conditions

Primary statuses are **stackable** — a Pokémon can be both burned and poisoned simultaneously, for example. This is a deliberate departure from the main series.

| Status | Effect |
| --- | --- |
| **Sleep** | Blocks action each turn; sleepTurns decrements per blocked turn (1–3 turns set on infliction); wake-up turn also blocked (Gen I rule) |
| **Freeze** | 80% chance to stay frozen each turn; thaw allows acting the same turn |
| **Paralysis** | 80% chance to fail to act; Speed halved for turn-order calculation |
| **Burn** | Physical Attack halved; end-of-turn damage equal to 1/16 max HP |
| **Poison** | End-of-turn damage equal to 1/8 max HP |
| **Confusion** | Volatile (separate from primary statuses); 2–5 turns; 50% chance per turn to hit itself for typeless physical damage (base power 40); cleared on switch |

If a Pokémon has both burn and poison, both deal end-of-turn damage in the same turn. If a Pokémon is asleep and also paralyzed, sleep takes priority and blocks action.

Ailments are inflicted by move metadata (`meta.ailment`, `meta.ailmentChance` from the local `moves.json` catalog). A `chance` of 0 means the ailment is the move's primary purpose and applies on every hit that deals damage.

### Items

Items are gated by the host's battle config (`useItems`). Only items with ID ≤ 126 from the local catalog are permitted; `cheri-berry` is excluded.

| Category | Examples | Effect |
| --- | --- | --- |
| **Healing** | Potion, Super Potion, Hyper Potion, Max Potion | Restore HP by flat amount or to full |
| **Medicine** | Full Restore | Heal to full HP and clear all status conditions |
| **Status cure** | Antidote, Burn Heal, Awakening, Paralyze Heal, Full Heal | Cure the matching status condition |
| **Revival** | Revive, Max Revive | Revive the first fainted bench Pokémon (half or full HP) |
| **Stat boost** | X Attack, X Defense, X Speed, X Sp. Atk, X Sp. Def | Multiply the target stat by ~1.5× for the remainder of the battle |

Held items are assigned per-Pokémon before the battle starts; the item must also be present in the player's bag.

Items are submitted as a turn action (priority 7, executes before attacks).

### Switching

- **Voluntary switch** — submitted as a turn action (priority 8, executes before items and attacks). Clears confusion on the outgoing Pokémon.
- **Forced switch** — automatic after a faint; the first non-fainted Pokémon on the bench becomes active.

### Turn Resolution Order

Each turn resolves in four phases:

1. **Phase 1 — Switches** (priority 8)
2. **Phase 2 — Items** (priority 7)
3. **Phase 3 — Attacks** — sorted by move priority, then effective Speed (paralysis ×0.5), then coin flip. Pre-attack status checks run in order: Sleep → Freeze → Paralysis → Confusion.
4. **Phase 4 — End-of-turn** — burn and poison damage applied to all active Pokémon.

---

## Running the Server

### Node.js

```bash
npm install
npm start
```

Equivalent to `node index.js`. No build step required.

### Docker

Single instance (no Redis):

```bash
docker build -t pokemon-server .
docker run -p 3000:3000 pokemon-server
```

With the included Compose file (adds an optional Redis container for multi-instance fan-out):

```bash
docker compose up --build
```

> **Redis note:** Redis is entirely optional for self-hosting. A single Node instance with in-memory rooms is the recommended path for personal use. Set `REDIS_URL` only if you are running multiple server instances behind a load balancer.

---

## Environment Variables

The server does not load `.env` automatically. Set variables in your shell, Docker `environment` block, or a process manager. Copy `.env.example` as a reference.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP / Socket.IO listen port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` to restrict to localhost only) |
| `CORS_ORIGIN` | `*` | Allowed origins for Socket.IO CORS. Set to your frontend URL for production (comma-separated list supported). Defaults to `*` so any client can connect — ideal for self-hosting. |
| `REDIS_URL` | unset | Enables the Socket.IO Redis adapter for multi-instance deployments. Not needed for single-instance self-hosting. |

---

## Health Check

```
GET /health  →  { "ok": true }
```

Use this to verify port-forwarding, tunnels, or firewall rules before troubleshooting Socket.IO.

---

## Room System

- Rooms are in-memory (not persisted). A server restart clears all rooms.
- Room codes are 6 alphanumeric characters generated with `nanoid`.
- Rooms expire automatically after **30 minutes** of inactivity.
- Maximum 2 players per room (configurable by the host up to the `DEFAULT_MAX_PLAYERS` limit).
- The host can close a room at any time; all players are notified.

---

## Documentation

- [Socket.IO Docs](https://socket.io/)
- [Node.js Docs](https://nodejs.org/docs/latest/api/)
- [Docker Docs](https://docs.docker.com/)
- [PokemonSite](https://github.com/Correu/PokemonSite) — the Angular frontend
