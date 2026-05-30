# Pokemon Site Server

### About the Project

Socket.io server for peer-to-peer battles in the Angular web app ([PokemonSite](https://github.com/Correu/PokemonSite)). The server handles room creation, joining, chat-style messages, and relaying battle game events between players.

## Documentation

- [Socket.IO Docs](https://socket.io/)
- [Node Docs](https://nodejs.org/docs/latest/api/)
- [Docker Docs](https://docs.docker.com/)

## Running the application

### Through Docker

### Through Node

run `node index.js` to run the application with Node.js.

## Scaling and cost controls

- **Default path (most cost-effective):** run one Node instance and keep in-memory rooms.
- **When traffic grows:** set `REDIS_URL` to enable Socket.io Redis pub/sub across instances.
- **CORS hardening:** set `CORS_ORIGIN` (comma-separated list supported) instead of `*`.
- **Compose includes Redis** for local validation of multi-instance event fan-out.
  From this directory:

```bash
docker compose up --build
```

The service listens on port **3000** (`http://localhost:3000`). See [.env.example](.env.example) for optional environment variables you can pass through `docker-compose` if needed.

### Through Node.js

```bash
npm install
npm start
```

Equivalent to `node index.js`.

## Self-hosting for remote 1v1

One player runs this server on their machine (Node or Docker). Both players point the **Angular client** at that host’s Socket.IO base URL (see the PokemonSite “Battle server” setting, build-time default, or `?socketUrl=` query parameter). The host shares:

1. The reachable URL of this server (for example `http://YOUR_LAN_IP:3000` or an HTTPS tunnel URL).
2. The short room code after creating a battle room.

Each room allows at most **two** participants (1v1). A third client receives `Room is full.`

### Exposing port 3000

Choose one (or combine):

- **Same computer, two browsers:** `http://localhost:3000` for both (typical dev setup).
- **Same LAN:** Allow inbound TCP **3000** on the host OS firewall; guest uses `http://<host-LAN-IP>:3000`.
- **Internet:** Router port-forward **3000** to the host, or use a tunnel (e.g. Cloudflare Tunnel, ngrok) forwarding to `localhost:3000` on the host machine.

### Health check

`GET /health` returns `{ "ok": true }`. Use it to verify port-forwarding or tunnels before debugging Socket.IO.

### Mixed content (HTTPS page vs HTTP socket)

If the Angular app is loaded over **HTTPS**, browsers may block plain **HTTP** WebSocket connections to your server. Mitigations:

- Test with the site over HTTP locally, or
- Expose the socket through an **HTTPS** tunnel / reverse proxy so the client uses an `https://` Socket.IO URL, or
- Terminate TLS in front of this process.

### Environment variables

Copy [.env.example](.env.example) and set values as needed. This project does not load `.env` automatically; use your shell, Docker `environment`, or a process manager to set variables (or add `dotenv` locally if you prefer).

| Variable      | Default   | Purpose                                   |
| ------------- | --------- | ----------------------------------------- |
| `PORT`        | `3000`    | HTTP / Socket.IO port                     |
| `HOST`        | `0.0.0.0` | Bind address (`127.0.0.1` for local only) |
| `CORS_ORIGIN` | `*`       | Optional comma-separated allowed origins  |
