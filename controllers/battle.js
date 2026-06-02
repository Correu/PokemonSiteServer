const { nanoid } = require("nanoid");

const rooms = {}; // { [roomKey]: { hostId, users, timer, battleConfig } }
const ROOM_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const ALLOWED_GAME_EVENT_TYPES = new Set([
  "battle:config",
  "battle:turn",
  "battle:matchStart",
]);

function isGameEventEnvelope(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.type !== "string") return false;
  if (!ALLOWED_GAME_EVENT_TYPES.has(value.type)) return false;
  if (value.version !== 1) return false;
  if (!value.payload || typeof value.payload !== "object") return false;
  return true;
}

module.exports = (io, socket) => {
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

  //user joins a room
  socket.on("joinRoom", (roomKey, cb) => {
    const room = rooms[roomKey];
    if (!room) {
      return cb({ error: "Room not found or expired." });
    }

    const alreadyInRoom = room.users.includes(socket.userId);
    if (!alreadyInRoom && room.users.length >= 2) {
      return cb({ error: "Room is full." });
    }

    if (!alreadyInRoom) {
      room.users.push(socket.userId);
    }

    socket.join(roomKey);
    if (!alreadyInRoom) {
      socket.to(roomKey).emit("playerJoined", socket.userId);
    }
    cb({ success: true, roomKey });
    // Late joiners miss the initial battle:config broadcast; replay from stored config.
    if (room.battleConfig) {
      socket.emit("gameEvent", {
        type: "battle:config",
        version: 1,
        payload: {
          level: room.battleConfig.level,
          itemQuantity: room.battleConfig.itemQuantity,
          generation: room.battleConfig.generation,
          useItems: room.battleConfig.useItems,
        },
      });
    }
    console.log(`👥 ${socket.userId} joined room ${roomKey}`);
  });

  //send message
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

  //user closes a room
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

  //game event
  socket.on("gameEvent", ({ roomId, data }) => {
    const room = rooms[roomId];
    if (!room) {
      return;
    }
    if (!isGameEventEnvelope(data)) {
      console.log(`⚠️ Invalid game event payload in room ${roomId}.`);
      return;
    }

    // Store battle configuration
    if (data.type === "battle:config") {
      const payload = data.payload;
      room.battleConfig = {
        level: payload.level,
        itemQuantity: payload.itemQuantity || 0,
        generation: payload.generation || null,
        useItems: payload.useItems || false,
      };
      console.log(`⚙️ Battle config saved for room ${roomId}:`, room.battleConfig);
    }

    if (data.type === "battle:matchStart") {
      room.matchStartedAt = data.payload?.startedAt ?? null;
      console.log(`▶️ Match start in room ${roomId}`);
    }

    // Broadcast the game event to all users in the room
    io.to(roomId).emit("gameEvent", data);
    console.log(`🎮 Game event in room ${roomId}:`, data);
  });

  //user leaves a room / Disconnect
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
