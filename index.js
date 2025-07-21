const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid"); // for room keys

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const battleController = require("./controllers/battle");

// Middleware (optional auth)
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  socket.userId = socket.id; // Replace with decoded token
  next();
});

io.on("connection", (socket) => {
  battleController(socket, io);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
