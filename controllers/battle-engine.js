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

// Gen I–IX type effectiveness chart.
// Row = attacking type, column = defending type.
// Missing entries default to 1× (neutral).
const TYPE_CHART = {
  normal:   { rock: 0.5, ghost: 0, steel: 0.5 },
  fire:     { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
  water:    { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  grass:    { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  ice:      { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison:   { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground:   { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying:   { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic:  { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug:      { fire: 0.5, grass: 2, fighting: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5, poison: 0.5 },
  rock:     { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost:    { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon:   { dragon: 2, steel: 0.5, fairy: 0 },
  dark:     { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel:    { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy:    { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 },
};

/**
 * Returns the combined type effectiveness multiplier for a move of `moveType`
 * against a defender with `defenderTypes` (1 or 2 types).
 * Possible values: 0, 0.25, 0.5, 1, 2, 4.
 */
function getTypeMultiplier(moveType, defenderTypes) {
  if (!moveType || !Array.isArray(defenderTypes) || defenderTypes.length === 0) {
    return 1;
  }
  let mult = 1;
  const attackType = moveType.toLowerCase();
  for (const defType of defenderTypes) {
    const row = TYPE_CHART[attackType];
    const val = row?.[defType.toLowerCase()];
    if (val !== undefined) mult *= val;
  }
  return mult;
}

// Allowed battle item categories. pp-recovery, vitamins, and species-specific
// are excluded: pp-recovery needs per-move targeting UI, the others have no
// meaningful in-battle effect.
const HEALING_CATEGORIES = new Set([
  "healing",
  "medicine",
  "status-cures",
  "revival",
]);
const STAT_CATEGORIES = new Set(["stat-boosts"]);

const BATTLE_ITEM_ID_MAX = 126;
const EXCLUDED_ITEM_NAMES = new Set(["cheri-berry"]);

let itemsCatalogById = {};

function loadItemsCatalog() {
  const catalogPath = path.join(__dirname, "..", "data", "items.json");
  try {
    const raw = fs.readFileSync(catalogPath, "utf8");
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) {
      throw new Error("items.json must be an array");
    }
    itemsCatalogById = {};
    for (const item of items) {
      if (item?.id) {
        itemsCatalogById[String(item.id)] = item;
      }
    }
  } catch (err) {
    console.warn(
      "[battle-engine] Could not load items catalog; item validation disabled.",
      err.message,
    );
    itemsCatalogById = {};
  }
}

loadItemsCatalog();

function getItemBattleType(item) {
  const category = item?.category?.name ?? "";
  if (HEALING_CATEGORIES.has(category)) return "healing";
  if (STAT_CATEGORIES.has(category)) return "stat";
  return null;
}

function isHoldableItem(item) {
  return (item?.attributes ?? []).some((a) => a.name === "holdable");
}

function isAllowedBattleItem(item, allowedTypes) {
  if (!item) return false;
  if (item.id > BATTLE_ITEM_ID_MAX) return false;
  if (EXCLUDED_ITEM_NAMES.has(item.name)) return false;
  const battleType = getItemBattleType(item);
  if (!battleType) return false;
  return allowedTypes.includes(battleType);
}

function validateItemLoadout(room, battlers, bagItems) {
  const config = room.battleConfig ?? {};
  const useItems = !!config.useItems;

  const hasBag = Array.isArray(bagItems) && bagItems.length > 0;
  const hasHeld = battlers.some((b) => b.heldItem?.id);

  if (!useItems) {
    if (hasBag || hasHeld) {
      return { error: "Items are disabled for this match." };
    }
    return { bagItems: [] };
  }

  const allowedTypes = config.allowedItemTypes ?? ["healing", "stat"];
  const itemSlotCount = config.itemSlotCount ?? config.itemQuantity ?? 6;
  const itemStackLimit = config.itemStackLimit ?? 3;
  const totalItemPool = config.totalItemPool ?? 10;

  const normalizedBag = [];
  let distinctCount = 0;
  let totalQty = 0;
  const bagIdSet = new Set();

  for (const entry of bagItems ?? []) {
    const qty = entry?.quantity ?? 0;
    if (qty <= 0) continue;

    const catalogItem = itemsCatalogById[String(entry.id)];
    if (!catalogItem) {
      return { error: `Invalid item id ${entry.id}.` };
    }
    if (!isAllowedBattleItem(catalogItem, allowedTypes)) {
      return { error: `${catalogItem.name} is not allowed in this match.` };
    }
    if (qty > itemStackLimit) {
      return {
        error: `Cannot bring more than ${itemStackLimit} of ${catalogItem.name}.`,
      };
    }

    distinctCount += 1;
    totalQty += qty;
    bagIdSet.add(entry.id);
    normalizedBag.push({
      id: catalogItem.id,
      name: catalogItem.name,
      quantity: qty,
      remaining: qty,
    });
  }

  if (distinctCount > itemSlotCount) {
    return {
      error: `You can only bring ${itemSlotCount} different item types.`,
    };
  }
  if (totalQty > totalItemPool) {
    return {
      error: `Total item uses cannot exceed ${totalItemPool}.`,
    };
  }

  for (const battler of battlers) {
    const held = battler.heldItem;
    if (!held?.id) {
      battler.heldItem = null;
      continue;
    }
    const catalogItem = itemsCatalogById[String(held.id)];
    if (!catalogItem || !isAllowedBattleItem(catalogItem, allowedTypes)) {
      return { error: `Held item ${held.name ?? held.id} is not allowed.` };
    }
    if (!isHoldableItem(catalogItem)) {
      return { error: `${catalogItem.name} cannot be held.` };
    }
    const inBag = normalizedBag.find((b) => b.id === held.id);
    if (!inBag || inBag.quantity < 1) {
      return {
        error: `Held item ${catalogItem.name} must be in your bag with quantity at least 1.`,
      };
    }
    battler.heldItem = { id: catalogItem.id, name: catalogItem.name };
  }

  return { bagItems: normalizedBag };
}

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
    statusConditions: [],
    sleepTurns: battler.sleepTurns ?? 0,
    confusionTurns: battler.confusionTurns ?? 0,
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
    return { damage: 0, typeMult: 1 };
  }

  const level = attacker.level;
  const power = move.power;
  const isSpecial = move.damageClass === "special";

  // Burn halves the physical Attack stat
  const rawAttack = isSpecial
    ? attacker.stats.specialAttack
    : attacker.stats.attack;
  const burnMod =
    !isSpecial && (attacker.statusConditions ?? []).includes("burn") ? 0.5 : 1;
  const attack = rawAttack * burnMod;

  const defense = isSpecial
    ? defender.stats.specialDefense
    : defender.stats.defense;

  const base = Math.floor(
    (((2 * level) / 5 + 2) * power * (attack / Math.max(1, defense))) / 50 + 2,
  );
  // STAB: 1.5× when move type matches one of the attacker's own types
  const stab = (attacker.types ?? []).includes(move.type) ? 1.5 : 1;
  // Type effectiveness (0 / 0.5 / 1 / 2 / 4)
  const typeMult = getTypeMultiplier(move.type, defender.types);
  const variance = 0.85 + Math.random() * 0.15;
  return { damage: Math.max(1, Math.floor(base * variance * stab * typeMult)), typeMult };
}

function applyMove(attackerId, defenderId, move, attackerTeam, defenderTeam) {
  const attacker = getActiveBattler(attackerTeam);
  const defender = getActiveBattler(defenderTeam);
  if (!attacker || !defender || attacker.isFainted || defender.isFainted) {
    return null;
  }

  const { damage, typeMult } = calcDamage(attacker, defender, move);
  defender.currentHp = Math.max(0, defender.currentHp - damage);
  if (defender.currentHp <= 0) {
    defender.currentHp = 0;
    defender.isFainted = true;
  }

  move.currentPp = Math.max(0, (move.currentPp ?? 1) - 1);

  // Attempt to inflict a status ailment on the defender
  let ailmentInflicted = null;
  if (!defender.isFainted) {
    const moveMeta = movesCatalogById[String(move.id)]?.meta;
    const ailment = moveMeta?.ailment;
    if (ailment && ailment !== "none") {
      const chance = moveMeta.ailmentChance ?? 0;
      // chance === 0 means the ailment IS the move's primary purpose (guaranteed)
      const willApply = chance === 0 ? true : Math.random() * 100 < chance;
      if (willApply) {
        if (ailment === "confusion") {
          // Volatile status — can stack with primary statuses
          if (!defender.confusionTurns) {
            defender.confusionTurns = Math.floor(Math.random() * 4) + 2; // 2–5 turns
            ailmentInflicted = "confusion";
          }
        } else {
          // Primary status — stackable (multiple primary statuses allowed)
          if (!defender.statusConditions) defender.statusConditions = [];
          if (!defender.statusConditions.includes(ailment)) {
            defender.statusConditions.push(ailment);
            if (ailment === "sleep") {
              defender.sleepTurns = Math.floor(Math.random() * 3) + 1;
            }
            ailmentInflicted = ailment;
          }
        }
      }
    }
  }

  return {
    attackerId,
    moveName: move.name,
    damage,
    typeMult,
    targetId: defenderId,
    targetFainted: defender.isFainted,
    ailmentInflicted,
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
    // Paralysis halves the effective Speed for turn-order purposes
    const activeA = getActiveBattler(teams[a]);
    const activeB = getActiveBattler(teams[b]);
    const rawSpeedA = activeA?.stats.speed ?? 0;
    const rawSpeedB = activeB?.stats.speed ?? 0;
    const speedA =
      (activeA?.statusConditions ?? []).includes("paralysis")
        ? Math.floor(rawSpeedA * 0.5)
        : rawSpeedA;
    const speedB =
      (activeB?.statusConditions ?? []).includes("paralysis")
        ? Math.floor(rawSpeedB * 0.5)
        : rawSpeedB;
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
  const teamSnapshot = {};
  const bagSnapshot = {};

  for (const playerId of room.users) {
    const team = info.teams[playerId];
    if (!team) {
      actives[playerId] = null;
      teamRemaining[playerId] = 0;
      teamSnapshot[playerId] = [];
      bagSnapshot[playerId] = [];
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
          statusConditions: active.statusConditions ?? [],
          confusionTurns: active.confusionTurns ?? 0,
        }
      : null;
    teamRemaining[playerId] = remainingCount(team);
    teamSnapshot[playerId] = team.battlers.map((b, idx) => ({
      name: b.name,
      displayName: b.displayName,
      speciesId: b.speciesId,
      currentHp: b.currentHp,
      maxHp: b.maxHp,
      isFainted: b.isFainted,
      isActive: idx === team.activeIndex,
      frontSprite: b.frontSprite,
      statusConditions: b.statusConditions ?? [],
      confusionTurns: b.confusionTurns ?? 0,
    }));
    bagSnapshot[playerId] = (team.bagItems ?? []).map((b) => {
      const catalogItem = itemsCatalogById[String(b.id)];
      const effect =
        catalogItem?.effect_entries?.find((e) => e.language?.name === "en")
          ?.short_effect ?? "";
      return { id: b.id, name: b.name, remaining: b.remaining, effect };
    });
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
    teamSnapshot,
    bagSnapshot,
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

function lockTeam(room, playerId, battlers, bagItems) {
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

  const itemValidation = validateItemLoadout(room, battlers, bagItems);
  if (itemValidation.error) {
    return { error: itemValidation.error };
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
    bagItems: itemValidation.bagItems ?? [],
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

// Resolve the effect of a status-cure item on the active battler.
function resolveStatusCureItem(item, battler, pokeName) {
  const itemName = item.name ?? "";
  let targetCondition = null;

  if (/full[\s-]heal/i.test(itemName)) {
    targetCondition = "all";
  } else if (/antidote/i.test(itemName)) {
    targetCondition = "poison";
  } else if (/burn[\s-]heal/i.test(itemName)) {
    targetCondition = "burn";
  } else if (/ice[\s-]heal/i.test(itemName)) {
    targetCondition = "freeze";
  } else if (/awakening/i.test(itemName)) {
    targetCondition = "sleep";
  } else if (/paralyze[\s-]heal|parlyz[\s-]heal/i.test(itemName)) {
    targetCondition = "paralysis";
  }

  if (!battler.statusConditions?.length) {
    return `But ${pokeName} has no status condition!`;
  }

  if (targetCondition === "all") {
    battler.statusConditions = [];
    battler.sleepTurns = 0;
    return `${pokeName}'s status was cleared!`;
  }

  const idx = battler.statusConditions.indexOf(targetCondition);
  if (idx !== -1) {
    battler.statusConditions.splice(idx, 1);
    if (targetCondition === "sleep") battler.sleepTurns = 0;
    return `${pokeName}'s ${targetCondition} was cured!`;
  }

  return `But it had no effect on ${pokeName}!`;
}

function resolveItemEffect(item, battler) {
  const category = item?.category?.name ?? "";
  const pokeName = battler.displayName || battler.name;

  // Status-cure items (Antidote, Burn Heal, Awakening, Paralyze Heal, Full Heal)
  if (category === "status-cures") {
    return resolveStatusCureItem(item, battler, pokeName);
  }

  // Medicine category: Full Restore — heals HP and cures all status
  if (category === "medicine") {
    const wasHealed = battler.currentHp < battler.maxHp;
    const hadStatus = (battler.statusConditions ?? []).length > 0;
    battler.currentHp = battler.maxHp;
    battler.statusConditions = [];
    battler.sleepTurns = 0;
    if (wasHealed && hadStatus) return `${pokeName} was fully restored!`;
    if (wasHealed) return `${pokeName} was fully healed!`;
    if (hadStatus) return `${pokeName}'s status was cured!`;
    return `${pokeName} used ${item.name}!`;
  }

  // HP healing (Potion, Super Potion, Hyper Potion, Max Potion)
  if (category === "healing") {
    const shortEffect =
      item.effect_entries?.find((e) => e.language?.name === "en")
        ?.short_effect ?? "";
    if (/full/i.test(shortEffect)) {
      battler.currentHp = battler.maxHp;
      return `${pokeName} was fully healed!`;
    }
    const flatMatch = shortEffect.match(/(\d+)\s*hp/i);
    const amount = flatMatch ? parseInt(flatMatch[1], 10) : 20;
    battler.currentHp = Math.min(battler.maxHp, battler.currentHp + amount);
    return `${pokeName} restored ${amount} HP!`;
  }

  // Stat boosts: X Attack, X Defense, X Speed, X Special, X Sp. Def, X Accuracy
  const name = item.name ?? "";
  let stat = null;
  let statLabel = "";
  if (/x[\s-]?attack/i.test(name)) {
    stat = "attack";
    statLabel = "Attack";
  } else if (/x[\s-]?sp[\s-]?def/i.test(name)) {
    stat = "specialDefense";
    statLabel = "Sp. Def";
  } else if (/x[\s-]?defense/i.test(name)) {
    stat = "defense";
    statLabel = "Defense";
  } else if (/x[\s-]?speed/i.test(name)) {
    stat = "speed";
    statLabel = "Speed";
  } else if (/x[\s-]?sp|x[\s-]?special|x[\s-]?spatk/i.test(name)) {
    stat = "specialAttack";
    statLabel = "Sp. Atk";
  } else if (/x[\s-]?accuracy/i.test(name)) {
    stat = "speed";
    statLabel = "Accuracy";
  }
  if (stat && battler.stats?.[stat] !== undefined) {
    battler.stats[stat] = Math.floor(battler.stats[stat] * 1.5);
    return `${pokeName}'s ${statLabel} rose!`;
  }

  return `${pokeName} used ${item.name}!`;
}

function resolvePendingTurn(room) {
  const info = room.battleInfo;
  const playerIds = room.users.filter((id) => {
    const team = info.teams[id];
    return team && remainingCount(team) > 0;
  });

  const messageParts = [];

  // Phase 1: Switches (highest priority — resolve before everything else)
  for (const playerId of playerIds) {
    const pending = info.pendingMoves[playerId];
    if (!pending?.isSwitch) continue;
    const team = info.teams[playerId];
    // Clear volatile statuses (confusion) from the outgoing Pokémon
    const outgoing = getActiveBattler(team);
    if (outgoing) {
      outgoing.confusionTurns = 0;
    }
    team.activeIndex = pending.switchToIndex;
    const newActive = getActiveBattler(team);
    const name = newActive?.displayName || newActive?.name || "Pokémon";
    messageParts.push(`Go, ${name}!`);
  }

  // Phase 2: Items (resolve after switches, before attacks)
  for (const playerId of playerIds) {
    const pending = info.pendingMoves[playerId];
    if (!pending?.isItem) continue;
    const team = info.teams[playerId];
    const bagItem = (team.bagItems ?? []).find(
      (b) => b.id === pending.itemId && b.remaining > 0,
    );
    if (!bagItem) continue;
    const catalogItem = itemsCatalogById[String(bagItem.id)];
    if (!catalogItem) continue;

    const itemCategory = catalogItem.category?.name ?? "";

    // Revival items target the first fainted bench member, not the active Pokémon
    if (itemCategory === "revival") {
      const faintedIdx = team.battlers.findIndex((b) => b.isFainted);
      bagItem.remaining -= 1;
      if (faintedIdx === -1) {
        messageParts.push("But there are no fainted Pokémon to revive!");
      } else {
        const revived = team.battlers[faintedIdx];
        const isMaxRevive = /max[\s-]revive/i.test(catalogItem.name);
        revived.currentHp = isMaxRevive
          ? revived.maxHp
          : Math.floor(revived.maxHp / 2);
        revived.isFainted = false;
        const revivedName = revived.displayName || revived.name;
        messageParts.push(
          `${revivedName} was revived${isMaxRevive ? " to full health" : ""}!`,
        );
      }
      continue;
    }

    // All other items target the currently active Pokémon
    const active = getActiveBattler(team);
    if (active && !active.isFainted) {
      const effectMsg = resolveItemEffect(catalogItem, active);
      bagItem.remaining -= 1;
      messageParts.push(effectMsg);
    }
  }

  // Phase 3: Attacks in speed/priority order (with status-condition checks)
  const attackerIds = playerIds.filter((id) => {
    const pending = info.pendingMoves[id];
    return pending && !pending.isSwitch && !pending.isItem;
  });
  const order = resolveTurnOrder(attackerIds, info.pendingMoves, info.teams);

  for (const attackerId of order) {
    const defenderId = playerIds.find((id) => id !== attackerId);
    if (!defenderId) break;

    const attackerTeam = info.teams[attackerId];
    const defenderTeam = info.teams[defenderId];
    if (!attackerTeam || !defenderTeam) continue;

    const attacker = getActiveBattler(attackerTeam);
    const defender = getActiveBattler(defenderTeam);
    if (!attacker || attacker.isFainted || !defender || defender.isFainted) {
      continue;
    }

    const attackerName = attacker.displayName || attacker.name;

    // Status condition prevention check
    let blocked = false;
    const attackerStatuses = attacker.statusConditions ?? [];

    // Sleep blocks first (highest priority)
    if (attackerStatuses.includes("sleep")) {
      if (attacker.sleepTurns > 0) {
        attacker.sleepTurns -= 1;
        messageParts.push(`${attackerName} is fast asleep!`);
        blocked = true;
      } else {
        // Wake-up turn: clear sleep but still can't act this turn (Gen 1 rule)
        attacker.statusConditions = attackerStatuses.filter((s) => s !== "sleep");
        messageParts.push(`${attackerName} woke up!`);
        blocked = true;
      }
    }

    // Freeze (only if not already blocked by sleep)
    if (!blocked && attackerStatuses.includes("freeze")) {
      if (Math.random() >= 0.2) {
        // 80% chance to remain frozen
        messageParts.push(`${attackerName} is frozen solid!`);
        blocked = true;
      } else {
        attacker.statusConditions = attacker.statusConditions.filter(
          (s) => s !== "freeze"
        );
        messageParts.push(`${attackerName} thawed out!`);
        // Pokémon can act the turn it thaws
      }
    }

    // Paralysis — 80% chance to fail (stacks with other statuses)
    if (!blocked && attackerStatuses.includes("paralysis")) {
      if (Math.random() < 0.8) {
        messageParts.push(`${attackerName} is paralyzed! It can't move!`);
        blocked = true;
      }
    }

    if (blocked) continue;

    // Confusion check — volatile status, resolved after primary status checks
    if (attacker.confusionTurns > 0) {
      attacker.confusionTurns -= 1;
      if (attacker.confusionTurns <= 0) {
        messageParts.push(`${attackerName} snapped out of confusion!`);
        // Falls through — can still use a move this turn
      } else {
        messageParts.push(`${attackerName} is confused!`);
        if (Math.random() < 0.5) {
          // Hurt itself in confusion: typeless physical, base power 40
          const level = attacker.level ?? 50;
          const atkStat = attacker.stats?.attack ?? 50;
          const defStat = attacker.stats?.defense ?? 50;
          const selfDmg = Math.max(
            1,
            Math.floor(
              (((2 * level) / 5 + 2) * 40 * (atkStat / defStat)) / 50 + 2
            )
          );
          attacker.currentHp = Math.max(0, attacker.currentHp - selfDmg);
          if (attacker.currentHp === 0) attacker.isFainted = true;
          messageParts.push(
            `${attackerName} hurt itself in its confusion! (${selfDmg} damage)`
          );
          blocked = true;
        }
      }
    }

    if (blocked) continue;

    const pending = info.pendingMoves[attackerId];
    const move = attacker.moves.find((m) => m.id === pending?.moveId);
    if (!move) continue;

    const log = applyMove(
      attackerId,
      defenderId,
      move,
      attackerTeam,
      defenderTeam,
    );
    if (log) {
      info.lastAction = log;
      messageParts.push(`${attackerName} used ${move.name}!`);
      if (log.damage > 0) {
        messageParts.push(`It dealt ${log.damage} damage.`);
        if (log.typeMult === 0) {
          const defName =
            getActiveBattler(defenderTeam)?.displayName ||
            getActiveBattler(defenderTeam)?.name ||
            "The opposing Pokémon";
          messageParts.push(`It doesn't affect ${defName}...`);
        } else if (log.typeMult >= 2) {
          messageParts.push("It's super effective!");
        } else if (log.typeMult > 0 && log.typeMult < 1) {
          messageParts.push("It's not very effective...");
        }
      }
      if (log.ailmentInflicted) {
        const defenderName =
          getActiveBattler(defenderTeam)?.displayName ||
          getActiveBattler(defenderTeam)?.name ||
          "The opposing Pokémon";
        const ailmentMsg = {
          burn:      `${defenderName} was burned!`,
          poison:    `${defenderName} was poisoned!`,
          paralysis: `${defenderName} was paralyzed!`,
          sleep:     `${defenderName} fell asleep!`,
          freeze:    `${defenderName} was frozen solid!`,
          confusion: `${defenderName} became confused!`,
        }[log.ailmentInflicted] ??
          `${defenderName} was afflicted with ${log.ailmentInflicted}!`;
        messageParts.push(ailmentMsg);
      }
      if (log.targetFainted) {
        messageParts.push("The opposing Pokémon fainted!");
      }
    }

    if (checkWinner(room)) {
      info.pendingMoves = {};
      return { resolved: true, winnerId: info.winnerId };
    }
  }

  // Auto-switch fainted active Pokémon
  for (const playerId of playerIds) {
    const team = info.teams[playerId];
    if (team) autoSwitchIfNeeded(team);
  }

  if (checkWinner(room)) {
    info.pendingMoves = {};
    return { resolved: true, winnerId: info.winnerId };
  }

  // Phase 4: End-of-turn status damage (burn and poison)
  const afterBattlePlayerIds = room.users.filter((id) => {
    const team = info.teams[id];
    return team && remainingCount(team) > 0;
  });

  for (const playerId of afterBattlePlayerIds) {
    const team = info.teams[playerId];
    if (!team) continue;
    const active = getActiveBattler(team);
    if (!active || active.isFainted) continue;

    const name = active.displayName || active.name;
    const endStatuses = active.statusConditions ?? [];

    if (endStatuses.includes("burn")) {
      const dmg = Math.max(1, Math.floor(active.maxHp / 16));
      active.currentHp = Math.max(0, active.currentHp - dmg);
      if (active.currentHp === 0) active.isFainted = true;
      messageParts.push(`${name} is hurt by its burn!`);
    }
    if (endStatuses.includes("poison")) {
      const dmg = Math.max(1, Math.floor(active.maxHp / 8));
      active.currentHp = Math.max(0, active.currentHp - dmg);
      if (active.currentHp === 0) active.isFainted = true;
      messageParts.push(`${name} is hurt by poison!`);
    }
  }

  if (checkWinner(room)) {
    info.pendingMoves = {};
    return { resolved: true, winnerId: info.winnerId };
  }

  info.turn += 1;
  info.pendingMoves = {};
  info.message =
    messageParts.length > 0
      ? `${messageParts.join(" ")} Turn ${info.turn}. Choose your move.`
      : `Turn ${info.turn}. Choose your move.`;

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

function submitSwitch(room, playerId, pokemonIndex, turnNumber) {
  const info = room.battleInfo;
  if (!info || info.status !== "in-battle" || info.winnerId) {
    return { error: "Battle is not active." };
  }
  if (!room.users.includes(playerId)) {
    return { error: "You are not in this room." };
  }
  if (turnNumber !== info.turn) {
    return { error: "Stale turn number." };
  }
  if (info.pendingMoves[playerId]) {
    return { error: "Action already submitted." };
  }

  const team = info.teams[playerId];
  if (!team || remainingCount(team) === 0) {
    return { error: "You have no usable Pokémon." };
  }

  const battlers = team.battlers;
  if (pokemonIndex < 0 || pokemonIndex >= battlers.length) {
    return { error: "Invalid Pokémon index." };
  }
  if (battlers[pokemonIndex].isFainted) {
    return { error: "That Pokémon has fainted." };
  }
  if (pokemonIndex === team.activeIndex) {
    return { error: "That Pokémon is already in battle." };
  }

  info.pendingMoves[playerId] = {
    isSwitch: true,
    switchToIndex: pokemonIndex,
    priority: 8,
  };

  const allSubmitted = room.users.every((id) => {
    const t = info.teams[id];
    if (!t || remainingCount(t) === 0) return true;
    const a = getActiveBattler(t);
    if (!a || a.isFainted) return true;
    return !!info.pendingMoves[id];
  });

  if (!allSubmitted) {
    info.message = "Waiting for opponent to choose an action…";
    return { resolved: false };
  }

  return resolvePendingTurn(room);
}

function submitItem(room, playerId, itemId, turnNumber) {
  const info = room.battleInfo;
  if (!info || info.status !== "in-battle" || info.winnerId) {
    return { error: "Battle is not active." };
  }
  if (!room.users.includes(playerId)) {
    return { error: "You are not in this room." };
  }
  if (turnNumber !== info.turn) {
    return { error: "Stale turn number." };
  }
  if (info.pendingMoves[playerId]) {
    return { error: "Action already submitted." };
  }

  const team = info.teams[playerId];
  if (!team) {
    return { error: "You have no team." };
  }

  const bagItem = (team.bagItems ?? []).find(
    (b) => b.id === itemId && b.remaining > 0,
  );
  if (!bagItem) {
    return { error: "Item not available." };
  }

  info.pendingMoves[playerId] = { isItem: true, itemId, priority: 7 };

  const allSubmitted = room.users.every((id) => {
    const t = info.teams[id];
    if (!t || remainingCount(t) === 0) return true;
    const a = getActiveBattler(t);
    if (!a || a.isFainted) return true;
    return !!info.pendingMoves[id];
  });

  if (!allSubmitted) {
    info.message = "Waiting for opponent to choose an action…";
    return { resolved: false };
  }

  return resolvePendingTurn(room);
}

function resetBattle(room) {
  room.battleInfo = initBattleInfo(room);
  room.status = "team-select";
  return { reset: true };
}

module.exports = {
  ensureBattleInfo,
  lockTeam,
  submitMove,
  submitSwitch,
  submitItem,
  resetBattle,
  buildStatePayload,
  forfeitMatch,
};
