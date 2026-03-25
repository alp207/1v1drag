const crypto = require("node:crypto");
const http = require("node:http");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 10000);
const TICK_RATE = 60;
const SNAPSHOT_EVERY_TICKS = 3;
const ROUND_RESET_MS = 1800;
const INVITE_TIMEOUT_MS = 10000;

const WORLD_WIDTH = 7200;
const WORLD_HEIGHT = 5200;
const ARENA = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2, radius: 1550 };
const PLAYER_RADIUS = 46;
const PLAYER_SPEED = 150;
const BOOST_MULTIPLIER = 1.2;
const MOVEMENT_RAMP_SECONDS = 0.42;
const NORMAL_ACCEL = 10;
const BOOST_ACCEL = 12;
const NORMAL_DRAG = 10;
const BOOST_DRAG = 8;
const WATER_REGEN_PER_SECOND = 8;
const WATER_BOOST_DRAIN_PER_SECOND = 16;
const PACKET_POINTER = 0x05;
const PACKET_RESIZE = 0x11;
const PACKET_SECONDARY = 0x14;
const PACKET_BOOST = 0x15;
const PACKET_INVITE_1V1 = 0x34;
const BITE_RANGE = 122;
const BITE_DAMAGE = 10;
const BITE_COOLDOWN = 0.42;

const clients = new Map();
const rooms = new Map();
let tickCounter = 0;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function approach(current, target, sharpness, dt) {
  return current + (target - current) * (1 - Math.exp(-sharpness * dt));
}

function normalize(x, y) {
  const length = Math.hypot(x, y);
  if (!length) {
    return { x: 0, y: 0, length: 0 };
  }

  return {
    x: x / length,
    y: y / length,
    length
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function createDragon(seed = {}) {
  return {
    x: Number.isFinite(seed.x) ? seed.x : ARENA.x - ARENA.radius * 0.42,
    y: Number.isFinite(seed.y) ? seed.y : ARENA.y,
    vx: Number.isFinite(seed.vx) ? seed.vx : 0,
    vy: Number.isFinite(seed.vy) ? seed.vy : 0,
    angle: Number.isFinite(seed.angle) ? seed.angle : 0,
    radius: Number.isFinite(seed.radius) ? seed.radius : PLAYER_RADIUS,
    health: Number.isFinite(seed.health) ? seed.health : 100,
    maxHealth: Number.isFinite(seed.maxHealth) ? seed.maxHealth : 100,
    water: Number.isFinite(seed.water) ? seed.water : 100,
    maxWater: Number.isFinite(seed.maxWater) ? seed.maxWater : 100,
    baseSpeed: Number.isFinite(seed.baseSpeed) ? seed.baseSpeed : PLAYER_SPEED,
    boosting: false,
    boostVisual: Number.isFinite(seed.boostVisual) ? seed.boostVisual : 0,
    healVisual: Number.isFinite(seed.healVisual) ? seed.healVisual : 0
  };
}

function socketIsOpen(client) {
  return client && client.ws && client.ws.readyState === WebSocket.OPEN;
}

function spawnPracticeDragon(client) {
  client.dragon = createDragon({
    x: ARENA.x - ARENA.radius * 0.42,
    y: ARENA.y,
    angle: 0
  });
  client.targetX = client.dragon.x + 120;
  client.targetY = client.dragon.y;
  client.boost = false;
  client.secondary = false;
  client.biteCooldown = 0;
  client.roundBites = 0;
}

function opponentFor(client) {
  if (!client.roomId) {
    return null;
  }

  const room = rooms.get(client.roomId);
  if (!room) {
    return null;
  }

  return room.players[0] === client ? room.players[1] : room.players[0];
}

function previewOpponentFor(client) {
  const preferredId = client.incomingInviteFrom || client.outgoingInviteTo;
  if (preferredId) {
    const preferred = clients.get(preferredId);
    if (preferred && preferred !== client && socketIsOpen(preferred) && !preferred.roomId) {
      return preferred;
    }
  }

  for (const candidate of clients.values()) {
    if (
      candidate === client ||
      !socketIsOpen(candidate) ||
      candidate.roomId ||
      candidate.incomingInviteFrom ||
      candidate.outgoingInviteTo
    ) {
      continue;
    }

    return candidate;
  }

  for (const candidate of clients.values()) {
    if (candidate === client || !socketIsOpen(candidate) || candidate.roomId) {
      continue;
    }

    return candidate;
  }

  return null;
}

function spawnRoom(room) {
  const [left, right] = room.players;

  left.dragon = createDragon({
    x: ARENA.x - ARENA.radius * 0.42,
    y: ARENA.y,
    angle: 0
  });
  right.dragon = createDragon({
    x: ARENA.x + ARENA.radius * 0.42,
    y: ARENA.y,
    angle: Math.PI
  });

  for (const client of room.players) {
    client.targetX = client.dragon.x + Math.cos(client.dragon.angle) * 120;
    client.targetY = client.dragon.y + Math.sin(client.dragon.angle) * 120;
    client.boost = false;
    client.secondary = false;
    client.biteCooldown = 0;
    client.roundBites = 0;
    client.outgoingInviteTo = null;
    client.incomingInviteFrom = null;
    client.inviteExpiresAt = 0;
  }
}

function clearInvitePair(inviter, target, inviterStatus = null, targetStatus = null) {
  if (inviter) {
    inviter.outgoingInviteTo = null;
    inviter.inviteExpiresAt = 0;
    if (inviterStatus) {
      inviter.status = inviterStatus;
    }
  }

  if (target) {
    target.incomingInviteFrom = null;
    target.inviteExpiresAt = 0;
    if (targetStatus) {
      target.status = targetStatus;
    }
  }

  if (inviter && socketIsOpen(inviter)) {
    sendSnapshot(inviter);
  }

  if (target && socketIsOpen(target)) {
    sendSnapshot(target);
  }
}

function clearClientInvites(client, status = null) {
  if (client.outgoingInviteTo) {
    const target = clients.get(client.outgoingInviteTo);
    clearInvitePair(
      client,
      target,
      status,
      target && !target.roomId ? "Practice mode live." : null
    );
    return;
  }

  if (client.incomingInviteFrom) {
    const inviter = clients.get(client.incomingInviteFrom);
    clearInvitePair(
      inviter,
      client,
      inviter && !inviter.roomId ? "Practice mode live." : null,
      status
    );
    return;
  }

  if (status) {
    client.status = status;
    sendSnapshot(client);
  }
}

function startLiveArena(inviter, target) {
  if (!socketIsOpen(inviter) || !socketIsOpen(target) || inviter.roomId || target.roomId) {
    clearInvitePair(inviter, target, "Practice mode live.", "Practice mode live.");
    return;
  }

  const room = {
    id: crypto.randomUUID(),
    players: [inviter, target],
    state: "running",
    resetAt: 0
  };

  inviter.roomId = room.id;
  target.roomId = room.id;
  inviter.status = "1v1 started. Right click or W to bite.";
  target.status = "1v1 started. Right click or W to bite.";
  spawnRoom(room);
  rooms.set(room.id, room);
  sendSnapshot(inviter);
  sendSnapshot(target);
}

function handleInvitePacket(client) {
  if (!socketIsOpen(client)) {
    return;
  }

  if (client.roomId) {
    client.status = "You are already inside a live 1v1 arena.";
    sendSnapshot(client);
    return;
  }

  if (client.incomingInviteFrom) {
    const inviter = clients.get(client.incomingInviteFrom);
    if (!inviter || inviter.outgoingInviteTo !== client.id) {
      clearClientInvites(client, "Practice mode live.");
      return;
    }

    startLiveArena(inviter, client);
    return;
  }

  if (client.outgoingInviteTo) {
    client.status = "Waiting for the other dragon to accept.";
    sendSnapshot(client);
    return;
  }

  const target = previewOpponentFor(client);
  if (!target) {
    client.status = "No other dragon is available right now.";
    sendSnapshot(client);
    return;
  }

  if (target.incomingInviteFrom || target.outgoingInviteTo) {
    client.status = "That dragon is busy right now.";
    sendSnapshot(client);
    return;
  }

  client.outgoingInviteTo = target.id;
  client.inviteExpiresAt = Date.now() + INVITE_TIMEOUT_MS;
  target.incomingInviteFrom = client.id;
  target.inviteExpiresAt = client.inviteExpiresAt;
  client.status = "1v1 request sent.";
  target.status = "Incoming 1v1 request.";
  sendSnapshot(client);
  sendSnapshot(target);
}

function expireInvites(now) {
  for (const client of clients.values()) {
    if (!client.outgoingInviteTo || !client.inviteExpiresAt || client.inviteExpiresAt > now) {
      continue;
    }

    const target = clients.get(client.outgoingInviteTo);
    clearInvitePair(client, target, "Invite expired.", target ? "Invite expired." : null);
  }
}

function clampToArena(dragon) {
  const dx = dragon.x - ARENA.x;
  const dy = dragon.y - ARENA.y;
  const distance = Math.hypot(dx, dy) || 1;
  const limit = ARENA.radius - dragon.radius - 8;

  if (distance > limit) {
    dragon.x = ARENA.x + (dx / distance) * limit;
    dragon.y = ARENA.y + (dy / distance) * limit;
    dragon.vx *= 0.28;
    dragon.vy *= 0.28;
  }

  dragon.x = clamp(dragon.x, dragon.radius, WORLD_WIDTH - dragon.radius);
  dragon.y = clamp(dragon.y, dragon.radius, WORLD_HEIGHT - dragon.radius);
}

function distanceToZone(entity, zone) {
  return Math.hypot(entity.x - zone.x, entity.y - zone.y);
}

function updateDragon(client, dt) {
  const dragon = client.dragon;
  if (!dragon) {
    return;
  }

  const previousX = dragon.x;
  const previousY = dragon.y;
  const targetX = client.targetX;
  const targetY = client.targetY;
  const direction = normalize(targetX - dragon.x, targetY - dragon.y);
  const distance = direction.length;
  const wantsBoost = client.boost && dragon.water > 0.5;
  const maxSpeed = dragon.baseSpeed * (wantsBoost ? BOOST_MULTIPLIER : 1);
  const targetSpeed = Math.min(maxSpeed, distance / MOVEMENT_RAMP_SECONDS);
  const accel = wantsBoost ? BOOST_ACCEL : NORMAL_ACCEL;
  const drag = wantsBoost ? BOOST_DRAG : NORMAL_DRAG;
  const easing = 1 - Math.exp(-accel * dt);

  dragon.vx += (direction.x * targetSpeed - dragon.vx) * easing;
  dragon.vy += (direction.y * targetSpeed - dragon.vy) * easing;

  if (distance < 0.001) {
    dragon.vx *= Math.exp(-drag * dt);
    dragon.vy *= Math.exp(-drag * dt);
  }

  const maxStep = maxSpeed * dt;
  const proposedStep = Math.hypot(dragon.vx * dt, dragon.vy * dt);
  const stepScale = proposedStep > maxStep && proposedStep > 0 ? maxStep / proposedStep : 1;

  dragon.x += dragon.vx * dt * stepScale;
  dragon.y += dragon.vy * dt * stepScale;
  dragon.vx = (dragon.x - previousX) / Math.max(dt, 0.0001);
  dragon.vy = (dragon.y - previousY) / Math.max(dt, 0.0001);

  const movement = Math.hypot(dragon.vx, dragon.vy);
  if (movement > 5) {
    dragon.angle = Math.atan2(dragon.vy, dragon.vx);
  }

  if (wantsBoost && distance > 0.001) {
    dragon.water = Math.max(0, dragon.water - WATER_BOOST_DRAIN_PER_SECOND * dt);
  }

  dragon.water = Math.min(dragon.maxWater, dragon.water + WATER_REGEN_PER_SECOND * dt);
  dragon.boosting = wantsBoost && distance > 0.001;
  dragon.boostVisual = approach(dragon.boostVisual, dragon.boosting ? 1 : 0, 10, dt);
  dragon.healVisual = approach(dragon.healVisual, 0, 9, dt);

  clampToArena(dragon);
}

function tryBite(attacker, defender, dt) {
  attacker.biteCooldown = Math.max(0, attacker.biteCooldown - dt);

  if (
    !attacker.secondary ||
    attacker.biteCooldown > 0 ||
    !attacker.dragon ||
    !defender.dragon ||
    defender.dragon.health <= 0
  ) {
    return;
  }

  const biteVector = normalize(
    defender.dragon.x - attacker.dragon.x,
    defender.dragon.y - attacker.dragon.y
  );
  const attackerFacingX = Math.cos(attacker.dragon.angle);
  const attackerFacingY = Math.sin(attacker.dragon.angle);
  const defenderFacingX = Math.cos(defender.dragon.angle);
  const defenderFacingY = Math.sin(defender.dragon.angle);
  const distance = biteVector.length;
  const attackerAlignment = biteVector.x * attackerFacingX + biteVector.y * attackerFacingY;
  const tailVectorX = attacker.dragon.x - defender.dragon.x;
  const tailVectorY = attacker.dragon.y - defender.dragon.y;
  const tailDirection = normalize(tailVectorX, tailVectorY);
  const tailAlignment = tailDirection.x * defenderFacingX + tailDirection.y * defenderFacingY;

  if (distance > BITE_RANGE || attackerAlignment < 0.12 || tailAlignment > -0.2) {
    return;
  }

  attacker.biteCooldown = BITE_COOLDOWN;
  attacker.roundBites += 1;
  defender.dragon.health = Math.max(0, defender.dragon.health - BITE_DAMAGE);
  attacker.status = "Tail bite landed.";
  defender.status = "Your tail was bitten.";
}

function finishRound(room, winner, loser) {
  winner.wins += 1;
  loser.losses += 1;
  winner.status = "Round won. Arena resetting...";
  loser.status = "Round lost. Arena resetting...";
  winner.boost = false;
  loser.boost = false;
  winner.secondary = false;
  loser.secondary = false;
  room.state = "resetting";
  room.resetAt = Date.now() + ROUND_RESET_MS;
}

function updateRoom(room, dt) {
  if (room.state === "resetting") {
    if (Date.now() >= room.resetAt) {
      spawnRoom(room);
      room.state = "running";
      for (const client of room.players) {
        client.status = "New round started.";
      }
    }
    return;
  }

  const [left, right] = room.players;
  updateDragon(left, dt);
  updateDragon(right, dt);
  tryBite(left, right, dt);
  tryBite(right, left, dt);

  if (left.dragon.health <= 0 || right.dragon.health <= 0) {
    const winner = left.dragon.health > 0 ? left : right;
    const loser = winner === left ? right : left;
    finishRound(room, winner, loser);
  }
}

function updateSoloClient(client, dt) {
  if (client.roomId) {
    return;
  }

  updateDragon(client, dt);
  if (client.incomingInviteFrom) {
    client.status = "Incoming 1v1 request.";
  } else if (client.outgoingInviteTo) {
    client.status = "Waiting for the other dragon to accept.";
  } else {
    client.status = "Practice mode live.";
  }
}

function serializeDragon(dragon) {
  return {
    x: round1(dragon.x),
    y: round1(dragon.y),
    vx: round1(dragon.vx),
    vy: round1(dragon.vy),
    angle: round1(dragon.angle),
    radius: dragon.radius,
    health: round1(dragon.health),
    maxHealth: dragon.maxHealth,
    water: round1(dragon.water),
    maxWater: dragon.maxWater,
    baseSpeed: dragon.baseSpeed,
    biteCooldown: round1(dragon.biteCooldown || 0),
    biteCooldownMax: BITE_COOLDOWN,
    boosting: dragon.boosting,
    boostVisual: round1(dragon.boostVisual),
    healVisual: round1(dragon.healVisual)
  };
}

function sendSnapshot(client) {
  if (!socketIsOpen(client) || !client.dragon) {
    return;
  }

  const roomOpponent = opponentFor(client);
  const opponent = roomOpponent || previewOpponentFor(client);
  const payload = {
    type: "snapshot",
    status: client.status,
    phase: roomOpponent ? "arena" : "practice",
    incomingInvite: client.incomingInviteFrom != null,
    outgoingInvite: client.outgoingInviteTo != null,
    player: serializeDragon(client.dragon),
    opponent: opponent && opponent.dragon ? serializeDragon(opponent.dragon) : null,
    round: {
      wins: client.wins,
      losses: client.losses,
      bites: client.roundBites,
      opponentBites: roomOpponent ? roomOpponent.roundBites : 0
    }
  };

  client.ws.send(JSON.stringify(payload));
}

function cleanupClient(client) {
  if (!clients.has(client.id)) {
    return;
  }

  clearClientInvites(client);

  const room = client.roomId ? rooms.get(client.roomId) : null;
  if (room) {
    const opponent = room.players[0] === client ? room.players[1] : room.players[0];
    rooms.delete(room.id);
    if (opponent) {
      opponent.roomId = null;
      opponent.status = "Opponent left. Practice mode live.";
      spawnPracticeDragon(opponent);
      sendSnapshot(opponent);
    }
  }

  clients.delete(client.id);
}

function handlePacket(client, message) {
  const payload = Buffer.isBuffer(message) ? message : Buffer.from(message);
  if (payload.length < 1) {
    return;
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const code = view.getUint8(0);

  switch (code) {
    case PACKET_POINTER:
      if (view.byteLength >= 5) {
        client.targetX = clamp(view.getInt16(1, false), 0, WORLD_WIDTH);
        client.targetY = clamp(view.getInt16(3, false), 0, WORLD_HEIGHT);
      }
      break;
    case PACKET_BOOST:
      client.boost = view.byteLength >= 2 && view.getUint8(1) === 1;
      break;
    case PACKET_SECONDARY:
      client.secondary = view.byteLength >= 2 && view.getUint8(1) === 1;
      break;
    case PACKET_INVITE_1V1:
      handleInvitePacket(client);
      break;
    case PACKET_RESIZE:
      break;
    default:
      break;
  }
}

function handleTextMessage(client, message) {
  let payload;

  try {
    payload = JSON.parse(message.toString());
  } catch (_error) {
    return;
  }

  if (!payload || payload.type !== "ping" || !socketIsOpen(client)) {
    return;
  }

  client.ws.send(JSON.stringify({
    type: "pong",
    sentAt: Number.isFinite(payload.sentAt) ? payload.sentAt : Date.now()
  }));
}

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, clients: clients.size, rooms: rooms.size }));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      ok: true,
      name: "dragon-duel-server",
      message: "WebSocket arena server is running."
    })
  );
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const client = {
    id: crypto.randomUUID(),
    ws,
    roomId: null,
    status: "Practice mode live.",
    dragon: null,
    targetX: ARENA.x,
    targetY: ARENA.y,
    boost: false,
    secondary: false,
    incomingInviteFrom: null,
    outgoingInviteTo: null,
    inviteExpiresAt: 0,
    biteCooldown: 0,
    wins: 0,
    losses: 0,
    roundBites: 0
  };

  clients.set(client.id, client);
  spawnPracticeDragon(client);
  sendSnapshot(client);

  ws.on("message", (message, isBinary) => {
    if (isBinary) {
      handlePacket(client, message);
      return;
    }

    handleTextMessage(client, message);
  });

  ws.on("close", () => {
    cleanupClient(client);
  });

  ws.on("error", () => {
    cleanupClient(client);
  });
});

setInterval(() => {
  const dt = 1 / TICK_RATE;
  tickCounter += 1;
  expireInvites(Date.now());

  for (const client of clients.values()) {
    if (!client.roomId) {
      updateSoloClient(client, dt);
    }
  }

  for (const room of rooms.values()) {
    updateRoom(room, dt);
  }

  if (tickCounter % SNAPSHOT_EVERY_TICKS === 0) {
    for (const client of clients.values()) {
      sendSnapshot(client);
    }
  }
}, Math.round(1000 / TICK_RATE));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Dragon duel server listening on :${PORT}`);
});
