const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid"); // for room keys

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});


// Middleware (optional auth)
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  socket.userId = socket.id; // Replace with decoded token
  next();
});

io.on("connection", (socket) => {
  // Handle game events
  socket.on("gameEvent", ({ roomId, data }) => {
    const room = rooms[roomId];
    if (!room) {
      return;
    }

    // Store battle configuration
    if (data.level && data.itemQuantity && data.generation) {
      room.battleConfig = {
        level: data.level,
        itemQuantity: data.itemQuantity,
        generation: data.generation,
      };
    }

    // Broadcast the game event to all users in the room
    io.to(roomId).emit("gameEvent", data);
    console.log(`🎮 Game event in room ${roomId}:`, data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
