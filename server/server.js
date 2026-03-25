const crypto = require("node:crypto");
const http = require("node:http");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 10000);
const TICK_RATE = 60;
const SNAPSHOT_EVERY_TICKS = 3;
const ROUND_RESET_MS = 1800;

const WORLD_WIDTH = 4600;
const WORLD_HEIGHT = 3200;
const ARENA = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2, radius: 1110 };
const WATER_ZONE = { x: ARENA.x - 250, y: ARENA.y + 250, radius: 175 };
const HEAL_ZONE = { x: ARENA.x + 300, y: ARENA.y - 230, radius: 145 };
const PLAYER_RADIUS = 46;
const PLAYER_SPEED = 270;
const BOOST_MULTIPLIER = 1.82;
const POSITION_LERP_SECONDS = 0.175;
const NORMAL_ACCEL = 16;
const BOOST_ACCEL = 18;
const NORMAL_DRAG = 8;
const BOOST_DRAG = 6;
const PACKET_POINTER = 0x05;
const PACKET_RESIZE = 0x11;
const PACKET_SECONDARY = 0x14;
const PACKET_BOOST = 0x15;
const PACKET_INVITE_1V1 = 0x34;
const BITE_RANGE = 122;
const BITE_DAMAGE = 23;
const BITE_HEAL = 6;
const BITE_COOLDOWN = 0.42;

const clients = new Map();
const waitingQueue = [];
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
  client.targetX = client.dragon.x + 160;
  client.targetY = client.dragon.y;
  client.boost = false;
  client.secondary = false;
  client.biteCooldown = 0;
  client.roundBites = 0;
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
    client.targetX = client.dragon.x + Math.cos(client.dragon.angle) * 160;
    client.targetY = client.dragon.y + Math.sin(client.dragon.angle) * 160;
    client.boost = false;
    client.secondary = false;
    client.biteCooldown = 0;
    client.roundBites = 0;
  }
}

function removeFromQueue(client) {
  client.queued = false;

  for (let index = waitingQueue.length - 1; index >= 0; index -= 1) {
    if (waitingQueue[index] === client) {
      waitingQueue.splice(index, 1);
    }
  }
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

function pairWaitingClients() {
  for (let index = waitingQueue.length - 1; index >= 0; index -= 1) {
    const candidate = waitingQueue[index];
    if (!socketIsOpen(candidate) || candidate.roomId) {
      waitingQueue.splice(index, 1);
      if (candidate) {
        candidate.queued = false;
      }
    }
  }

  while (waitingQueue.length >= 2) {
    const first = waitingQueue.shift();
    const second = waitingQueue.shift();

    if (!socketIsOpen(first) || !socketIsOpen(second) || first.roomId || second.roomId) {
      if (socketIsOpen(first) && !first.roomId) {
        queueClient(first, "Waiting for another dragon...");
      }
      if (socketIsOpen(second) && !second.roomId) {
        queueClient(second, "Waiting for another dragon...");
      }
      continue;
    }

    first.queued = false;
    second.queued = false;

    const room = {
      id: crypto.randomUUID(),
      players: [first, second],
      state: "running",
      resetAt: 0
    };

    first.roomId = room.id;
    second.roomId = room.id;
    first.status = "1v1 started. Right click or W to bite.";
    second.status = "1v1 started. Right click or W to bite.";
    spawnRoom(room);
    rooms.set(room.id, room);
    sendSnapshot(first);
    sendSnapshot(second);
  }
}

function queueClient(client, status = "Waiting for another dragon...") {
  if (!socketIsOpen(client)) {
    return;
  }

  if (client.roomId) {
    client.status = "You are already inside a live 1v1 arena.";
    sendSnapshot(client);
    return;
  }

  if (!client.queued) {
    waitingQueue.push(client);
    client.queued = true;
  }

  client.status = status;
  pairWaitingClients();
  sendSnapshot(client);
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
  const targetSpeed = Math.min(maxSpeed, distance / POSITION_LERP_SECONDS);
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

  const inWater = distanceToZone(dragon, WATER_ZONE) <= WATER_ZONE.radius - dragon.radius * 0.15;
  const inHeal = distanceToZone(dragon, HEAL_ZONE) <= HEAL_ZONE.radius - dragon.radius * 0.1;

  if (wantsBoost && distance > 0.001) {
    dragon.water = Math.max(0, dragon.water - 24 * dt);
  }

  if (inWater) {
    dragon.water = Math.min(dragon.maxWater, dragon.water + 36 * dt);
  }

  if (inHeal) {
    dragon.health = Math.min(dragon.maxHealth, dragon.health + 13 * dt);
  }

  dragon.boosting = wantsBoost && distance > 0.001;
  dragon.boostVisual = approach(dragon.boostVisual, dragon.boosting ? 1 : 0, 10, dt);
  dragon.healVisual = approach(dragon.healVisual, inHeal ? 1 : 0, 9, dt);

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
  const facingX = Math.cos(attacker.dragon.angle);
  const facingY = Math.sin(attacker.dragon.angle);
  const distance = biteVector.length;
  const alignment = biteVector.x * facingX + biteVector.y * facingY;

  if (distance > BITE_RANGE || alignment < 0.12) {
    return;
  }

  attacker.biteCooldown = BITE_COOLDOWN;
  attacker.roundBites += 1;
  defender.dragon.health = Math.max(0, defender.dragon.health - BITE_DAMAGE);
  attacker.dragon.health = Math.min(attacker.dragon.maxHealth, attacker.dragon.health + BITE_HEAL);
  attacker.status = "Bite landed.";
  defender.status = "You were bitten.";
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
  client.status = client.queued ? "Waiting for another dragon..." : "Practice only.";
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
    boosting: dragon.boosting,
    boostVisual: round1(dragon.boostVisual),
    healVisual: round1(dragon.healVisual)
  };
}

function sendSnapshot(client) {
  if (!socketIsOpen(client) || !client.dragon) {
    return;
  }

  const opponent = opponentFor(client);
  const payload = {
    status: client.status,
    phase: client.roomId ? "arena" : "practice",
    player: serializeDragon(client.dragon),
    opponent: opponent && opponent.dragon ? serializeDragon(opponent.dragon) : null,
    round: {
      wins: client.wins,
      losses: client.losses,
      bites: client.roundBites,
      opponentBites: opponent ? opponent.roundBites : 0
    }
  };

  client.ws.send(JSON.stringify(payload));
}

function cleanupClient(client) {
  if (!clients.has(client.id)) {
    return;
  }

  removeFromQueue(client);

  const room = client.roomId ? rooms.get(client.roomId) : null;
  if (room) {
    const opponent = room.players[0] === client ? room.players[1] : room.players[0];
    rooms.delete(room.id);
    if (opponent) {
      opponent.roomId = null;
      opponent.status = "Opponent left. Waiting for another dragon...";
      spawnPracticeDragon(opponent);
      queueClient(opponent, opponent.status);
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
      queueClient(client, "Searching for a dragon duel...");
      break;
    case PACKET_RESIZE:
      break;
    default:
      break;
  }
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
    queued: false,
    status: "Waiting for another dragon...",
    dragon: null,
    targetX: ARENA.x,
    targetY: ARENA.y,
    boost: false,
    secondary: false,
    biteCooldown: 0,
    wins: 0,
    losses: 0,
    roundBites: 0
  };

  clients.set(client.id, client);
  spawnPracticeDragon(client);
  queueClient(client, "Waiting for another dragon...");

  ws.on("message", (message, isBinary) => {
    if (!isBinary) {
      return;
    }

    handlePacket(client, message);
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
