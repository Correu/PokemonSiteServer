/**
 * Lightweight turn-based PvP resolver.
 * Damage formulas are placeholders until full stat/type logic is added.
 */

const fs = require("fs");
const path = require("path");

let movesCatalogById = {};

function loadMovesCatalog() {
  const catalogPath = path.join(__dirname, "..", "data", "moves.json");
  try {
    const raw = fs.readFileSync(catalogPath, "utf8");
    const catalog = JSON.parse(raw);
    movesCatalogById = catalog.byId ?? {};
  } catch (err) {
    console.warn(
      "[battle-engine] Could not load moves catalog; PP defaults will be used.",
      err.message,
    );
    movesCatalogById = {};
  }
}

loadMovesCatalog();

function getMovePp(moveId) {
  const entry = movesCatalogById[String(moveId)];
  if (entry && typeof entry.pp === "number") {
    return entry.pp;
  }
  return 5;
}

function normalizeCombatMove(move) {
  const maxPp = getMovePp(move.id);
  return {
    ...move,
    maxPp,
    currentPp:
      typeof move.currentPp === "number"
        ? Math.min(move.currentPp, maxPp)
        : maxPp,
  };
}

function normalizeBattlerMoves(battler) {
  if (!Array.isArray(battler.moves)) {
    battler.moves = [];
    return;
  }
  battler.moves = battler.moves.map(normalizeCombatMove);
}

function cloneBattler(battler) {
  const cloned = {
    ...battler,
    stats: { ...battler.stats },
    moves: battler.moves.map((m) => ({ ...m })),
  };
  normalizeBattlerMoves(cloned);
  return cloned;
}

function initBattleInfo(room) {
  return {
    teams: {},
    lockedPlayers: [],
    turn: 1,
    pendingMoves: {},
    winnerId: null,
    status: "team-select",
    message: "Waiting for both players to lock in their teams.",
  };
}

function ensureBattleInfo(room) {
  if (!room.battleInfo || !room.battleInfo.teams) {
    room.battleInfo = initBattleInfo(room);
  }
  return room.battleInfo;
}

function remainingCount(team) {
  return team.battlers.filter((b) => !b.isFainted).length;
}

function getActiveBattler(team) {
  return team.battlers[team.activeIndex] ?? null;
}

function findNextActiveIndex(team) {
  for (let i = 0; i < team.battlers.length; i++) {
    if (!team.battlers[i].isFainted) {
      return i;
    }
  }
  return -1;
}

function autoSwitchIfNeeded(team) {
  const active = getActiveBattler(team);
  if (active && !active.isFainted) {
    return false;
  }
  const next = findNextActiveIndex(team);
  if (next < 0) {
    return true;
  }
  team.activeIndex = next;
  return false;
}

function calcDamage(attacker, defender, move) {
  if (!move || move.damageClass === "status" || !move.power) {
    return 0;
  }

  const level = attacker.level;
  const power = move.power;
  const isSpecial = move.damageClass === "special";
  const attack = isSpecial
    ? attacker.stats.specialAttack
    : attacker.stats.attack;
  const defense = isSpecial
    ? defender.stats.specialDefense
    : defender.stats.defense;

  const base = Math.floor(
    (((2 * level) / 5 + 2) * power * (attack / Math.max(1, defense))) / 50 + 2,
  );
  const variance = 0.85 + Math.random() * 0.15;
  return Math.max(1, Math.floor(base * variance));
}

function applyMove(attackerId, defenderId, move, attackerTeam, defenderTeam) {
  const attacker = getActiveBattler(attackerTeam);
  const defender = getActiveBattler(defenderTeam);
  if (!attacker || !defender || attacker.isFainted || defender.isFainted) {
    return null;
  }

  const damage = calcDamage(attacker, defender, move);
  defender.currentHp = Math.max(0, defender.currentHp - damage);
  if (defender.currentHp <= 0) {
    defender.currentHp = 0;
    defender.isFainted = true;
  }

  move.currentPp = Math.max(0, (move.currentPp ?? 1) - 1);

  return {
    attackerId,
    moveName: move.name,
    damage,
    targetId: defenderId,
    targetFainted: defender.isFainted,
  };
}

function resolveTurnOrder(playerIds, pendingMoves, teams) {
  return [...playerIds].sort((a, b) => {
    const moveA = pendingMoves[a];
    const moveB = pendingMoves[b];
    const prioA = moveA?.priority ?? 0;
    const prioB = moveB?.priority ?? 0;
    if (prioA !== prioB) {
      return prioB - prioA;
    }
    const speedA = getActiveBattler(teams[a])?.stats.speed ?? 0;
    const speedB = getActiveBattler(teams[b])?.stats.speed ?? 0;
    if (speedA !== speedB) {
      return speedB - speedA;
    }
    return Math.random() > 0.5 ? -1 : 1;
  });
}

function checkWinner(room) {
  const info = room.battleInfo;
  const playerIds = room.users;
  const alive = playerIds.filter((id) => {
    const team = info.teams[id];
    return team && remainingCount(team) > 0;
  });

  if (alive.length === 1) {
    info.winnerId = alive[0];
    info.status = "finished";
    room.status = "finished";
    info.message = `Player ${alive[0]} wins!`;
    return alive[0];
  }
  if (alive.length === 0) {
    info.winnerId = null;
    info.status = "finished";
    room.status = "finished";
    info.message = "The battle ended in a draw.";
    return null;
  }
  return null;
}

function mapActiveMoves(active) {
  if (!active?.moves?.length) {
    return undefined;
  }
  return active.moves.map((m) => ({
    id: m.id,
    name: m.name,
    power: m.power ?? null,
    type: m.type ?? null,
    damageClass: m.damageClass ?? null,
    priority: m.priority ?? 0,
    maxPp: m.maxPp ?? getMovePp(m.id),
    currentPp: m.currentPp ?? m.maxPp ?? getMovePp(m.id),
  }));
}

function buildStatePayload(room) {
  const info = room.battleInfo;
  const actives = {};
  const teamRemaining = {};

  for (const playerId of room.users) {
    const team = info.teams[playerId];
    if (!team) {
      actives[playerId] = null;
      teamRemaining[playerId] = 0;
      continue;
    }
    const active = getActiveBattler(team);
    actives[playerId] = active
      ? {
          speciesId: active.speciesId,
          name: active.name,
          displayName: active.displayName,
          level: active.level,
          maxHp: active.maxHp,
          currentHp: active.currentHp,
          frontSprite: active.frontSprite,
          backSprite: active.backSprite,
          isFainted: active.isFainted,
          moves: mapActiveMoves(active),
        }
      : null;
    teamRemaining[playerId] = remainingCount(team);
  }

  const awaitingMoves =
    info.status === "in-battle" && !info.winnerId
      ? room.users.filter((id) => {
          const team = info.teams[id];
          if (!team || remainingCount(team) === 0) {
            return false;
          }
          const active = getActiveBattler(team);
          if (!active || active.isFainted) {
            return false;
          }
          return !info.pendingMoves[id];
        })
      : [];

  return {
    turn: info.turn,
    message: info.message,
    actives,
    teamRemaining,
    awaitingMoves,
    lockedPlayers: [...info.lockedPlayers],
    winnerId: info.winnerId,
    battleStarted: info.status === "in-battle" && !info.winnerId,
    lastAction: info.lastAction ?? undefined,
  };
}

function usersWithTeams(room) {
  const info = room.battleInfo;
  if (!info) return 0;
  return room.users.filter((id) => info.teams[id]?.battlers?.length > 0).length;
}

function allUsersHaveTeams(room) {
  const info = room.battleInfo;
  if (!info || room.users.length === 0) return false;
  return room.users.every((id) => info.teams[id]?.battlers?.length > 0);
}

function lockTeam(room, playerId, battlers) {
  const info = ensureBattleInfo(room);
  if (!Array.isArray(battlers) || battlers.length === 0) {
    return { error: "Team must include at least one Pokémon." };
  }

  const teamSize = room.battleConfig?.teamSize ?? 6;
  if (battlers.length > teamSize) {
    return { error: `Team cannot exceed ${teamSize} Pokémon.` };
  }

  if (info.status === "in-battle" && !info.winnerId) {
    return { error: "Battle already in progress." };
  }

  for (const battler of battlers) {
    if (!Array.isArray(battler.moves) || battler.moves.length === 0) {
      return { error: "Each Pokémon must have at least one move." };
    }
    normalizeBattlerMoves(battler);
  }

  info.teams[playerId] = {
    battlers: battlers.map(cloneBattler),
    activeIndex: 0,
  };

  if (!info.lockedPlayers.includes(playerId)) {
    info.lockedPlayers.push(playerId);
  }

  if (!allUsersHaveTeams(room)) {
    const ready = usersWithTeams(room);
    const needed = room.users.length;
    info.message = `Waiting for opponent to lock in (${ready}/${needed}).`;
    return { started: false };
  }

  info.status = "in-battle";
  room.status = "in-battle";
  info.turn = 1;
  info.pendingMoves = {};
  info.winnerId = null;
  info.message = "Battle start! Choose your move.";
  return { started: true };
}

function submitMove(room, playerId, moveId, turnNumber) {
  const info = room.battleInfo;
  if (!info || info.status !== "in-battle" || info.winnerId) {
    return { error: "Battle is not active." };
  }

  if (!room.users.includes(playerId)) {
    return { error: "You are not in this room." };
  }

  const team = info.teams[playerId];
  if (!team || remainingCount(team) === 0) {
    return { error: "You have no usable Pokémon." };
  }

  const active = getActiveBattler(team);
  if (!active || active.isFainted) {
    return { error: "Your active Pokémon cannot move." };
  }

  const move = active.moves.find((m) => m.id === moveId);
  if (!move) {
    return { error: "Invalid move." };
  }

  if ((move.currentPp ?? 0) <= 0) {
    return { error: "No PP left for that move." };
  }

  if (turnNumber !== info.turn) {
    return { error: "Stale turn number." };
  }

  if (info.pendingMoves[playerId]) {
    return { error: "Move already submitted." };
  }

  info.pendingMoves[playerId] = { moveId, priority: move.priority ?? 0 };

  const allSubmitted = room.users.every((id) => {
    const t = info.teams[id];
    if (!t || remainingCount(t) === 0) {
      return true;
    }
    const a = getActiveBattler(t);
    if (!a || a.isFainted) {
      return true;
    }
    return !!info.pendingMoves[id];
  });

  if (!allSubmitted) {
    info.message = "Waiting for opponent to choose a move…";
    return { resolved: false };
  }

  return resolvePendingTurn(room);
}

function resolvePendingTurn(room) {
  const info = room.battleInfo;
  const playerIds = room.users.filter((id) => {
    const team = info.teams[id];
    return team && remainingCount(team) > 0;
  });

  const order = resolveTurnOrder(playerIds, info.pendingMoves, info.teams);
  const logs = [];

  for (const attackerId of order) {
    const defenderId = playerIds.find((id) => id !== attackerId);
    if (!defenderId) {
      break;
    }

    const attackerTeam = info.teams[attackerId];
    const defenderTeam = info.teams[defenderId];
    if (!attackerTeam || !defenderTeam) {
      continue;
    }

    const attacker = getActiveBattler(attackerTeam);
    const defender = getActiveBattler(defenderTeam);
    if (!attacker || attacker.isFainted || !defender || defender.isFainted) {
      continue;
    }

    const pending = info.pendingMoves[attackerId];
    const move = attacker.moves.find((m) => m.id === pending?.moveId);
    if (!move) {
      continue;
    }

    const log = applyMove(
      attackerId,
      defenderId,
      move,
      attackerTeam,
      defenderTeam,
    );
    if (log) {
      logs.push(log);
      info.lastAction = log;
      const displayName = attacker.displayName || attacker.name;
      info.message = `${displayName} used ${move.name}!`;
      if (log.damage > 0) {
        info.message += ` It dealt ${log.damage} damage.`;
      }
      if (log.targetFainted) {
        info.message += " The opposing Pokémon fainted!";
      }
    }

    if (checkWinner(room)) {
      info.pendingMoves = {};
      return { resolved: true, winnerId: info.winnerId };
    }
  }

  for (const playerId of playerIds) {
    const team = info.teams[playerId];
    if (team) {
      autoSwitchIfNeeded(team);
    }
  }

  if (checkWinner(room)) {
    info.pendingMoves = {};
    return { resolved: true, winnerId: info.winnerId };
  }

  info.turn += 1;
  info.pendingMoves = {};
  info.message = `Turn ${info.turn}. Choose your move.`;

  return { resolved: true, winnerId: null };
}

function forfeitMatch(room, playerId) {
  const info = room.battleInfo;
  if (!info || info.status !== "in-battle" || info.winnerId) {
    return { error: "Battle is not active." };
  }
  if (!room.users.includes(playerId)) {
    return { error: "You are not in this room." };
  }

  const winnerId = room.users.find((id) => id !== playerId) ?? null;
  info.winnerId = winnerId;
  info.status = "finished";
  room.status = "finished";
  info.pendingMoves = {};
  info.message = "The fight ended — one player forfeited.";
  return { winnerId };
}

module.exports = {
  ensureBattleInfo,
  lockTeam,
  submitMove,
  buildStatePayload,
  forfeitMatch,
};
