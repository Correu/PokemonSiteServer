const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

function getCorsOrigin() {
  const raw = process.env.CORS_ORIGIN;
  if (!raw || String(raw).trim() === "") {
    return "*";
  }
  const list = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) {
    return "*";
  }
  if (list.length === 1) {
    return list[0];
  }
  return list;
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: getCorsOrigin(), methods: ["GET", "POST"] },
});

const battleController = require("./controllers/battle");
const encounterController = require("./controllers/encounters");

// Middleware (optional auth)
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  socket.userId = socket.id; // Replace with decoded token
  next();
});

io.on("connection", (socket) => {
  battleController(io, socket);
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server listening on ${HOST}:${PORT}`);
  console.log(
    `   Health check: http://127.0.0.1:${PORT}/health (use your LAN or public URL for remote clients)`
  );
});
