const { nanoid } = require("nanoid");

const rooms = {}; // { [roomKey]: { hostId, users, timer, battleConfig } }
const ROOM_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

module.exports = (io, socket) => {
  //user creates a room
  const createRoom = (req, res) => {
    const { roomName } = req.body;
    const roomKey = nanoid(6);
    res.json({ roomKey });

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
        battleConfig: null,
      };

      cb({ roomKey }); // Return roomKey to frontend
      console.log(`🛠️ Room ${roomKey} created by ${socket.userId}`);
    });
  };

  //user joins a room
  const joinRoom = (req, res) => {
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
  };

  //send message
  const sendMessage = (req, res) => {
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
      console.log(
        `💬 Message from ${socket.userId} to room ${roomKey}: ${message}`
      );
    });
  };

  //user leaves a room
  const leaveRoom = (req, res) => {
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
  };

  //user closes a room
  const closeRoom = (req, res) => {
    // close room
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
  };
};
