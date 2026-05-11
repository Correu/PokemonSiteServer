const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");

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

const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:4200";
const corsOrigins = corsOrigin.split(",").map((origin) => origin.trim());
const io = new Server(server, {
  cors: { origin: corsOrigins, methods: ["GET", "POST"] },
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

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL;

async function setupRedisAdapterIfEnabled() {
  if (!REDIS_URL) {
    console.log("ℹ️ Redis adapter disabled (REDIS_URL not set).");
    return;
  }

  const pubClient = createClient({ url: REDIS_URL });
  const subClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  console.log("✅ Redis adapter enabled for Socket.io.");
}

async function startServer() {
  try {
    await setupRedisAdapterIfEnabled();
    server.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`🌐 Allowed CORS origins: ${corsOrigins.join(", ")}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
