const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid"); // for room keys

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const rooms = {}; // { [roomKey]: { hostId, users, timer } }
const ROOM_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Middleware (optional auth)
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  socket.userId = socket.id; // Replace with decoded token
  next();
});

io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.userId);

  // Create Room
  socket.on("createRoom", (_, cb) => {
    const roomKey = nanoid(6); // e.g., "af9D4z"
    socket.join(roomKey);

    const timer = setTimeout(() => {
      io.to(roomKey).emit("roomExpired");
      delete rooms[roomKey];
      io.in(roomKey).socketsLeave(roomKey);
      console.log(`⌛ Room ${roomKey} expired`);
    }, ROOM_TIMEOUT_MS);

    rooms[roomKey] = {
      hostId: socket.userId,
      users: [socket.userId],
      timer,
    };

    cb({ roomKey }); // Return roomKey to frontend
    console.log(`🛠️ Room ${roomKey} created by ${socket.userId}`);
  });

  // Join Room
  socket.on("joinRoom", (roomKey, cb) => {
    const room = rooms[roomKey];
    if (!room) {
      return cb({ error: "Room not found or expired." });
    }

    socket.join(roomKey);
    room.users.push(socket.userId);

    socket.to(roomKey).emit("playerJoined", socket.userId);
    cb({ success: true, roomKey });
    console.log(`👥 ${socket.userId} joined room ${roomKey}`);
  });

  socket.on("sendMessage", ({ roomKey, message }, cb) => {
    const room = rooms[roomKey];
    if (!room) {
      return cb?.({ error: "Room not found or expired." });
    }

    const payload = {
      senderId: socket.userId,
      message,
      timestamp: new Date().toISOString(),
    };

    io.to(roomKey).emit("receiveMessage", payload);
    cb?.({ success: true });
    console.log(`💬 Message from ${socket.userId} to room ${roomKey}: ${message}`);
  });

  // Leave Room / Disconnect
  socket.on("disconnect", () => {
    console.log("❌ Disconnected:", socket.userId);

    // Cleanup from all rooms
    for (const [roomKey, room] of Object.entries(rooms)) {
      const index = room.users.indexOf(socket.userId);
      if (index !== -1) {
        room.users.splice(index, 1);
        socket.to(roomKey).emit("playerLeft", socket.userId);

        // If host left or room is empty
        if (room.hostId === socket.userId || room.users.length === 0) {
          clearTimeout(room.timer);
          delete rooms[roomKey];
          io.in(roomKey).socketsLeave(roomKey);
          console.log(
            `🧹 Room ${roomKey} closed due to host disconnect or empty room.`
          );
        }
      }
    }
  });

  // Optional: Host can manually close room
  socket.on("closeRoom", (roomKey) => {
    const room = rooms[roomKey];
    if (room && room.hostId === socket.userId) {
      clearTimeout(room.timer);
      delete rooms[roomKey];
      io.to(roomKey).emit("roomClosed");
      io.in(roomKey).socketsLeave(roomKey);
      console.log(`🚪 Room ${roomKey} closed by host.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// const express = require("express");
// const http = require("http");
// const { Server } = require("socket.io");
// const cors = require("cors");

// const app = express();
// app.use(cors()); // optional: adjust to your client origin

// const server = http.createServer(app);
// const io = new Server(server, {
//   cors: {
//     origin: "*", // or specify your frontend URL
//     methods: ["GET", "POST"],
//   },
// });

// // Socket.IO logic
// io.on("connection", (socket) => {
//   console.log(`New connection: ${socket.id}`);

//   socket.on("joinBattle", (battleId) => {
//     socket.join(battleId);
//     io.to(battleId).emit("playerJoined", socket.id);
//   });

//   socket.on("makeMove", ({ battleId, move }) => {
//     socket.to(battleId).emit("opponentMove", move);
//   });

//   socket.on("disconnect", () => {
//     console.log(`Socket disconnected: ${socket.id}`);
//   });

//   socket.on("test", (message) => {
//     console.log(message);
//   });
// });

// // Start server
// const PORT = process.env.PORT || 3000;
// server.listen(PORT, () => {
//   console.log(`Socket.IO server running on port ${PORT}`);
// });
