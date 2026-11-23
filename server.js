'use strict';
// ============================================================
//  친구 배신 게임 - 서버 (모든 중요한 값은 여기서 계산/검증한다)
// ============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e4, pingInterval: 10000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

// ---------------- 상수 ----------------
const W = 1800, H = 1200;
const CAMP = { x: 900, y: 600 };
const DOCK = { x: 300, y: 1060 };
const DURATION = 660;        // 게임 길이(초)
const TICK = 0.05;           // 서버 틱(초) = 20Hz
const MAX_PLAYERS = 8;
const SPEED = 170;
const EMOJIS = ['🐱', '🐶', '🐰', '🦊', '🐻', '🐼', '🐸', '🐯'];
const RES = ['wood', 'stone', 'food', 'part', 'gem'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const ZONES = {
  forest: { name: '숲', emoji: '🌲', x: 0, y: 0, w: 700, h: 550 },
  mine: { name: '광산', emoji: '🪨', x: 1100, y: 0, w: 700, h: 550 },
  beach: { name: '해변', emoji: '🏖️', x: 0, y: 650, w: 700, h: 550 },
  ruins: { name: '폐건물', emoji: '🏚️', x: 1100, y: 650, w: 700, h: 550 },
  hazard: { name: '위험 지역', emoji: '🌋', x: 750, y: 880, w: 300, h: 320 },
};
const SPAWN_TABLE = {
  forest: [['wood', 12], ['food', 4]],
  mine: [['stone', 12], ['gem', 2]],
  beach: [['food', 8], ['wood', 3]],
  ruins: [['part', 10], ['stone', 2], ['gem', 1]],
  hazard: [['gem', 4], ['part', 2]],
  grass: [['wood', 4], ['stone', 3]],
};
const RESPAWN = { wood: 18, stone: 22, food: 20, part: 30 };

const RECIPES = {
  axe: { name: '도끼', emoji: '🪓', cost: { wood: 3, stone: 2 }, max: 1, desc: '나무·돌을 한 번에 2개씩 채집' },
  armor: { name: '방어구', emoji: '🛡️', cost: { stone: 5, part: 2 }, max: 1, desc: '받는 피해가 절반으로 줄어듦' },
  shield: { name: '임시 방어막', emoji: '🔮', cost: { wood: 5 }, max: 3, desc: '사용하면 25초간 피해·도난을 막아줌' },
  trap: { name: '함정', emoji: '🪤', cost: { wood: 2, part: 2 }, max: 3, desc: '설치하면 밟은 상대의 자원을 빼앗고 피해를 줌' },
  hook: { name: '갈고리', emoji: '🪝', cost: { stone: 2, part: 1 }, max: 2, desc: '가까운 상대의 자원을 최대 3개 훔침' },
};
const CAMP_COST = {
  2: { wood: 8, stone: 4 },
  3: { wood: 10, stone: 8, part: 3 },
  4: { stone: 10, part: 6, food: 6 },
  5: { wood: 12, stone: 12, part: 8, gem: 3 },
};
const EVENT_NAMES = {
  storm: '🌪️ 폭풍', meteor: '🪨 운석', wildlife: '🐗 야생동물', treasure: '💎 보물상자',
  volcano: '🌋 화산 폭발', rain: '🌧️ 폭우', fog: '🌫️ 안개',
};
const EVENT_DUR = { storm: 20, meteor: 10, wildlife: 25, treasure: 15, volcano: 14, rain: 25, fog: 25 };

// ---------------- 유틸 ----------------
const rooms = new Map();
const rnd = (a, b) => a + Math.random() * (b - a);
const rint = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isNight = (t) => (t % 150) >= 95;
const safeRadius = (room) => (room.camp.level >= 4 ? 260 : 150);
const inRect = (z, x, y, pad = 0) => x >= z.x - pad && x <= z.x + z.w + pad && y >= z.y - pad && y <= z.y + z.h + pad;

function zoneOf(x, y) {
  if (dist(x, y, CAMP.x, CAMP.y) <= 150) return 'camp';
  for (const k of ['hazard', 'forest', 'mine', 'beach', 'ruins']) if (inRect(ZONES[k], x, y)) return k;
  return 'grass';
}
function inHazard(room, x, y) {
  return inRect(ZONES.hazard, x, y, room.volcanoUntil > room.t ? 150 : 0);
}
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
const rid = (n) => crypto.randomBytes(n).toString('hex');
function cleanName(s) {
  s = String(s || '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 8);
  return s || '플레이어';
}
function parseBundle(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  let sum = 0;
  for (const k of RES) {
    const v = Math.floor(Number(o[k]) || 0);
    if (v < 0 || v > 50) return null;
    out[k] = v; sum += v;
  }
  return { b: out, sum };
}
const hasBundle = (p, b) => RES.every((k) => p.inv[k] >= b[k]);
function bundleText(b) {
  const N = { wood: '나무', stone: '돌', food: '음식', part: '부품', gem: '보석' };
  return RES.filter((k) => b[k] > 0).map((k) => `${N[k]} ${b[k]}`).join(', ') || '없음';
}

// ---------------- 방/플레이어 ----------------
function createRoom() {
  const room = {
    code: newCode(), hostPid: null, players: new Map(), state: 'lobby',
    t: 0, nid: 0, nodes: [], nodesDirty: false, respawns: [],
    camp: { level: 1, pool: { wood: 0, stone: 0, food: 0, part: 0, gem: 0 } },
    ship: { active: false, departAt: 0, departed: false, seats: 1, boarded: [], fullAt: 0 },
    event: null, nextEventAt: 30, lastEvent: null, volcanoUntil: 0,
    meteors: [], boars: [], traps: [], trades: new Map(), allyReqs: new Map(),
    gemTimer: 10, secTimer: 0, loop: null, lastTick: 0, results: null, createdAt: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, name) {
  const used = new Set([...room.players.values()].map((p) => p.emoji));
  const names = new Set([...room.players.values()].map((p) => p.name));
  let n = name, i = 2;
  while (names.has(n)) { n = name.slice(0, 6) + i; i++; }
  const p = {
    pid: rid(4), token: rid(8), name: n, emoji: EMOJIS.find((e) => !used.has(e)) || '🐾',
    sid: null, connected: true, offlineAt: 0, lastChat: 0,
    x: CAMP.x, y: CAMP.y, hp: 100, alive: true, boarded: false,
    inv: {}, allies: new Set(), input: { x: 0, y: 0, at: 0 }, stats: {}, visited: new Set(),
    shieldUntil: 0, betrayerUntil: 0, hookCd: 0, collectCd: 0, recent: new Map(),
    mission: null, missionNotified: false,
  };
  room.players.set(p.pid, p);
  if (!room.hostPid) room.hostPid = p.pid;
  return p;
}
function emitLobby(room) {
  io.to(room.code).emit('lobby', {
    code: room.code, host: room.hostPid, state: room.state,
    players: [...room.players.values()].map((p) => ({ pid: p.pid, name: p.name, emoji: p.emoji, on: p.connected ? 1 : 0 })),
  });
}
const sendTo = (p, ev, data) => { if (p.sid) io.to(p.sid).emit(ev, data); };
const toast = (p, text, kind = 'info') => sendTo(p, 'toast', { text, kind });
const logAll = (room, text) => io.to(room.code).emit('log', { text });

function reassignHost(room) {
  const cur = room.players.get(room.hostPid);
  if (cur && cur.connected) return;
  const next = [...room.players.values()].find((p) => p.connected);
  if (next) room.hostPid = next.pid;
}

// ---------------- 게임 시작 ----------------
const MISSION_TYPES = ['gems', 'visit', 'trade', 'camp', 'craft', 'survive', 'ally', 'gather'];
function makeMission(id) {
  switch (id) {
    case 'gems': return { id, text: '보석 5개 모으기', goal: 5 };
    case 'visit': { const z = pick(['hazard', 'ruins', 'mine', 'beach']); return { id, zone: z, text: `${ZONES[z].name} 방문하기`, goal: 1 }; }
    case 'trade': return { id, text: '다른 플레이어와 거래 3번 하기', goal: 3 };
    case 'camp': return { id, text: '캠프에 자원 12개 넣기', goal: 12 };
    case 'craft': return { id, text: '아이템 3개 만들기', goal: 3 };
    case 'survive': return { id, text: '끝까지 생존하기', goal: 1 };
    case 'ally': return { id, text: '동맹을 맺고 총 60초 유지하기', goal: 60 };
    default: return { id: 'gather', text: '자원 40개 채집하기', goal: 40 };
  }
}
function startGame(room) {
  for (const [id, p] of room.players) if (!p.connected) room.players.delete(id);
  const list = [...room.players.values()];
  const n = list.length;
  const missions = MISSION_TYPES.slice().sort(() => Math.random() - 0.5);
  list.forEach((p, i) => {
    const ang = (i / n) * Math.PI * 2;
    p.x = CAMP.x + Math.cos(ang) * 70; p.y = CAMP.y + Math.sin(ang) * 70;
    p.hp = 100; p.alive = true; p.boarded = false;
    p.inv = { wood: 2, stone: 0, food: 2, part: 0, gem: 0, axe: 0, armor: 0, shield: 0, trap: 0, hook: 0 };
    p.allies = new Set(); p.input = { x: 0, y: 0, at: 0 };
    p.stats = { gems: 0, trades: 0, camp: 0, crafts: 0, gather: 0, allySec: 0, betray: 0 };
    p.visited = new Set(); p.shieldUntil = 0; p.betrayerUntil = 0; p.hookCd = 0; p.collectCd = 0;
    p.recent = new Map(); p.missionNotified = false;
    p.mission = makeMission(missions[i % missions.length]);
  });
  room.state = 'playing'; room.t = 0; room.nid = 0; room.nodes = []; room.respawns = [];
  room.camp = { level: 1, pool: { wood: 0, stone: 0, food: 0, part: 0, gem: 0 } };
  room.ship = { active: false, departAt: 0, departed: false, seats: Math.max(1, Math.floor(n / 2)), boarded: [], fullAt: 0 };
  room.event = null; room.nextEventAt = 30; room.lastEvent = null; room.volcanoUntil = 0;
  room.meteors = []; room.boars = []; room.traps = []; room.trades.clear(); room.allyReqs.clear();
  room.gemTimer = 10; room.secTimer = 0; room.results = null;
  for (const zone of Object.keys(SPAWN_TABLE)) {
    for (const [type, count] of SPAWN_TABLE[zone]) for (let i = 0; i < count; i++) spawnNode(room, type, zone);
  }
  io.to(room.code).emit('started', configOf(room));
  io.to(room.code).emit('nodes', nodesList(room));
  room.nodesDirty = false;
  room.lastTick = Date.now();
  clearInterval(room.loop);
  room.loop = setInterval(() => {
    try {
      const now = Date.now();
      const dt = Math.min(0.2, (now - room.lastTick) / 1000);
      room.lastTick = now;
      tickRoom(room, dt);
    } catch (e) { console.error('tick error', e); }
  }, TICK * 1000);
  logAll(room, '🏝️ 게임 시작! 비밀 미션을 확인하고 섬을 탐험해봐!');
  for (const p of list) toast(p, `🎯 비밀 미션: ${p.mission.text}`, 'good');
}
function configOf(room) {
  return { W, H, CAMP, DOCK, zones: ZONES, recipes: RECIPES, campCost: CAMP_COST, dur: DURATION };
}

// ---------------- 맵 노드 ----------------
function randPoint(zoneKey) {
  for (let i = 0; i < 40; i++) {
    let x, y;
    if (zoneKey === 'grass') {
      x = rnd(40, W - 40); y = rnd(40, H - 40);
      if (zoneOf(x, y) !== 'grass') continue;
    } else {
      const z = ZONES[zoneKey];
      x = rnd(z.x + 40, z.x + z.w - 40); y = rnd(z.y + 40, z.y + z.h - 40);
    }
    if (dist(x, y, CAMP.x, CAMP.y) < 180 || dist(x, y, DOCK.x, DOCK.y) < 80) continue;
    return { x, y };
  }
  return { x: 200, y: 200 };
}
function spawnNode(room, type, zone, extra) {
  const pt = randPoint(zone);
  const n = { id: ++room.nid, type, zone, x: Math.round(pt.x), y: Math.round(pt.y) };
  if (extra) Object.assign(n, extra);
  room.nodes.push(n);
  room.nodesDirty = true;
  return n;
}
const nodesList = (room) => room.nodes.map((n) => [n.id, n.type, n.x, n.y]);
function removeNode(room, n) {
  room.nodes = room.nodes.filter((m) => m !== n);
  room.nodesDirty = true;
  if (RESPAWN[n.type]) {
    const mul = room.event && room.event.type === 'rain' ? 0.5 : 1;
    room.respawns.push({ at: room.t + RESPAWN[n.type] * mul * rnd(0.8, 1.2), type: n.type, zone: n.zone });
  }
}

// ---------------- 피해/사망 ----------------
function applyDamage(room, p, amt, cause) {
  if (!p.alive || p.boarded || amt <= 0) return false;
  if (p.shieldUntil > room.t) return false;
  if (p.inv.armor) amt *= 0.5;
  p.hp -= amt;
  if (p.hp <= 0) { p.hp = 0; killPlayer(room, p, cause); }
  return true;
}
function envDamage(room, p, amt) {
  for (const id of p.allies) {
    const o = room.players.get(id);
    if (o && o.alive && !o.boarded && dist(o.x, o.y, p.x, p.y) < 200) { amt *= 0.7; break; }
  }
  applyDamage(room, p, amt, '환경');
}
function killPlayer(room, p, cause) {
  p.alive = false; p.hp = 0;
  for (const id of p.allies) { const o = room.players.get(id); if (o) o.allies.delete(p.pid); }
  p.allies.clear();
  logAll(room, `💀 ${p.emoji} ${p.name} 탈락!${cause ? ` (${cause})` : ''}`);
  toast(p, '탈락했어... 이제 관전 모드야 👻', 'bad');
}

// ---------------- 이벤트 ----------------
function startEvent(room) {
  const type = pick(Object.keys(EVENT_NAMES).filter((x) => x !== room.lastEvent));
  room.lastEvent = type;
  const t = room.t;
  room.event = { type, until: t + EVENT_DUR[type] };
  const alive = [...room.players.values()].filter((p) => p.alive && !p.boarded);
  const sr = safeRadius(room);
  switch (type) {
    case 'meteor': {
      const count = Math.min(9, alive.length + 3);
      for (let i = 0; i < count; i++) {
        let x, y;
        const target = i < alive.length ? alive[i] : null;
        if (target) { x = target.x + rnd(-120, 120); y = target.y + rnd(-120, 120); }
        else { x = rnd(60, W - 60); y = rnd(60, H - 60); }
        x = clamp(x, 40, W - 40); y = clamp(y, 40, H - 40);
        if (dist(x, y, CAMP.x, CAMP.y) < sr + 40) {
          const a = Math.atan2(y - CAMP.y, x - CAMP.x);
          x = clamp(CAMP.x + Math.cos(a) * (sr + 60), 40, W - 40); y = clamp(CAMP.y + Math.sin(a) * (sr + 60), 40, H - 40);
        }
        room.meteors.push({ x, y, at: t + 3.5 + i * 0.4 });
      }
      break;
    }
    case 'wildlife':
      for (let i = 0; i < 2; i++) {
        const edge = Math.random() < 0.5;
        room.boars.push({ x: edge ? pick([30, W - 30]) : rnd(50, W - 50), y: edge ? rnd(50, H - 50) : pick([30, H - 30]), cd: 0, dir: rnd(0, 6.28) });
      }
      break;
    case 'treasure': {
      const zones = ['forest', 'mine', 'beach', 'ruins', 'grass'];
      for (let i = 0; i < 2; i++) {
        const z = pick(zones);
        spawnNode(room, 'chest', z, { expires: t + 90 });
      }
      break;
    }
    case 'volcano': room.volcanoUntil = t + EVENT_DUR.volcano; break;
    default: break;
  }
  logAll(room, `${EVENT_NAMES[type]} 발생!`);
}
function endEvent(room) {
  if (room.event && room.event.type === 'wildlife') room.boars = [];
  room.event = null;
  room.nextEventAt = room.t + rnd(30, 45);
}

// ---------------- 배신 ----------------
function betray(room, betrayer, victim, how) {
  betrayer.allies.delete(victim.pid); victim.allies.delete(betrayer.pid);
  if (betrayer.stats.betray < 2) betrayer.stats.betray++;
  betrayer.betrayerUntil = room.t + 90;
  logAll(room, `😈 ${betrayer.emoji} ${betrayer.name} 이(가) ${victim.emoji} ${victim.name} 을(를) 배신했다! (${how})`);
  toast(betrayer, '😈 배신 성공! +150점 (90초간 배신자 표식 · 동맹 불가)', 'good');
  toast(victim, `😈 ${betrayer.name} 에게 배신당했어!`, 'bad');
}
function stealFrom(room, thief, victim, maxN) {
  let got = 0; const taken = {};
  for (let i = 0; i < maxN; i++) {
    const have = RES.filter((k) => victim.inv[k] > 0);
    if (!have.length) break;
    const k = pick(have);
    victim.inv[k]--; thief.inv[k] = Math.min(99, thief.inv[k] + 1);
    taken[k] = (taken[k] || 0) + 1; got++;
  }
  return { got, taken };
}

// ---------------- 점수/미션 ----------------
function missionProgress(p, final) {
  const m = p.mission; if (!m) return { cur: 0, goal: 1, done: false };
  let cur = 0;
  switch (m.id) {
    case 'gems': cur = p.stats.gems; break;
    case 'visit': cur = p.visited.has(m.zone) ? 1 : 0; break;
    case 'trade': cur = p.stats.trades; break;
    case 'camp': cur = p.stats.camp; break;
    case 'craft': cur = p.stats.crafts; break;
    case 'ally': cur = Math.floor(p.stats.allySec); break;
    case 'gather': cur = p.stats.gather; break;
    case 'survive': cur = p.alive ? 1 : 0; break;
    default: break;
  }
  const done = m.id === 'survive' ? !!(final && p.alive) : cur >= m.goal;
  return { cur: Math.min(cur, m.goal), goal: m.goal, done };
}
function scoreParts(room, p, final) {
  const m = missionProgress(p, final);
  const parts = {
    survive: final && p.alive ? 100 : 0,
    escape: final && p.boarded && room.ship.departed ? 300 : 0,
    mission: m.done ? 200 : 0,
    gems: Math.min(3, Math.floor(p.stats.gems / 3)) * 100,
    camp: p.stats.camp >= 10 ? 50 : 0,
    betray: p.stats.betray * 150,
    ally: Math.min(4, Math.floor(p.stats.allySec / 60)) * 30,
  };
  return { parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}

// ---------------- 종료 ----------------
function endGame(room, reason) {
  if (room.state !== 'playing') return;
  room.state = 'ended';
  clearInterval(room.loop); room.loop = null;
  if (room.ship.active) room.ship.departed = true;
  const rows = [...room.players.values()].map((p) => {
    const sc = scoreParts(room, p, true);
    return {
      pid: p.pid, name: p.name, emoji: p.emoji, total: sc.total, parts: sc.parts,
      alive: p.alive, boarded: p.boarded, mission: p.mission ? p.mission.text : '',
      missionDone: missionProgress(p, true).done,
    };
  }).sort((a, b) => b.total - a.total);
  room.results = { reason, rows };
  io.to(room.code).emit('ended', Object.assign({}, room.results, { host: room.hostPid }));
}

// ---------------- 메인 틱 ----------------
function tickRoom(room, dt) {
  if (room.state !== 'playing') return;
  room.t += dt;
  const t = room.t;
  const night = isNight(t);
  const players = [...room.players.values()];

  if (room.event && room.event.until <= t) endEvent(room);
  if (!room.event && t >= room.nextEventAt) startEvent(room);
  const ev = room.event;
  const sr = safeRadius(room);
  const speedMul = ev ? (ev.type === 'storm' ? 0.7 : ev.type === 'rain' ? 0.85 : 1) : 1;

  for (const p of players) {
    if (!p.alive || p.boarded) continue;
    // 이동 (서버가 계산)
    if (Date.now() - p.input.at < 600) {
      let vx = p.input.x, vy = p.input.y;
      const len = Math.hypot(vx, vy);
      if (len > 1) { vx /= len; vy /= len; }
      p.x = clamp(p.x + vx * SPEED * speedMul * dt, 20, W - 20);
      p.y = clamp(p.y + vy * SPEED * speedMul * dt, 20, H - 20);
    }
    p.visited.add(zoneOf(p.x, p.y));
    const inSafe = dist(p.x, p.y, CAMP.x, CAMP.y) <= sr;
    if (inSafe) {
      p.hp = Math.min(100, p.hp + (room.camp.level >= 2 ? 5 : 2) * dt);
    } else {
      let d = 0;
      if (night) d += 1.2;
      if (ev && ev.type === 'storm') d += 1.5;
      if (d) envDamage(room, p, d * dt);
      if (p.alive && inHazard(room, p.x, p.y)) envDamage(room, p, (room.volcanoUntil > t ? 8 : 4) * dt);
    }
    if (p.alive && p.allies.size) p.stats.allySec += dt;
  }

  // 함정
  if (room.traps.length) {
    const remain = [];
    for (const tr of room.traps) {
      const owner = room.players.get(tr.owner);
      let hit = null;
      for (const q of players) {
        if (!q.alive || q.boarded || q.pid === tr.owner) continue;
        if (owner && owner.allies.has(q.pid)) continue;
        if (dist(q.x, q.y, tr.x, tr.y) < 30) { hit = q; break; }
      }
      if (!hit) { remain.push(tr); continue; }
      const shielded = hit.shieldUntil > t;
      if (shielded) {
        toast(hit, '🔮 방어막이 함정을 막아줬어!', 'good');
      } else {
        applyDamage(room, hit, 15, '함정');
        if (owner) {
          const r = stealFrom(room, owner, hit, 2);
          toast(hit, `🪤 함정에 걸렸다! 자원 ${r.got}개를 잃었어`, 'bad');
          toast(owner, `🪤 함정 발동! ${hit.name} 에게서 자원 ${r.got}개 획득`, 'good');
          if (tr.allyAtPlace.has(hit.pid)) betray(room, owner, hit, '함정');
        } else toast(hit, '🪤 함정에 걸렸다!', 'bad');
      }
    }
    room.traps = remain;
  }

  // 운석
  if (room.meteors.length) {
    const remain = [];
    for (const m of room.meteors) {
      if (m.at > t) { remain.push(m); continue; }
      for (const q of players) {
        if (q.alive && !q.boarded && dist(q.x, q.y, m.x, m.y) < 70) {
          if (applyDamage(room, q, 30, '운석')) toast(q, '☄️ 운석에 맞았다!', 'bad');
        }
      }
    }
    room.meteors = remain;
  }

  // 멧돼지
  for (const b of room.boars) {
    let tgt = null, bd = 450;
    for (const q of players) {
      if (!q.alive || q.boarded) continue;
      if (dist(q.x, q.y, CAMP.x, CAMP.y) <= sr) continue;
      const d = dist(b.x, b.y, q.x, q.y);
      if (d < bd) { bd = d; tgt = q; }
    }
    if (tgt) {
      const a = Math.atan2(tgt.y - b.y, tgt.x - b.x);
      b.x += Math.cos(a) * 105 * dt; b.y += Math.sin(a) * 105 * dt;
      if (bd < 34 && t >= b.cd) {
        b.cd = t + 1.5;
        if (applyDamage(room, tgt, 12, '야생동물')) toast(tgt, '🐗 멧돼지에게 받혔다!', 'bad');
      }
    } else {
      if (Math.random() < 0.02) b.dir = rnd(0, 6.28);
      b.x += Math.cos(b.dir) * 40 * dt; b.y += Math.sin(b.dir) * 40 * dt;
    }
    const dc = dist(b.x, b.y, CAMP.x, CAMP.y);
    if (dc < sr + 15) {
      const a = Math.atan2(b.y - CAMP.y, b.x - CAMP.x);
      b.x = CAMP.x + Math.cos(a) * (sr + 15); b.y = CAMP.y + Math.sin(a) * (sr + 15);
    }
    b.x = clamp(b.x, 10, W - 10); b.y = clamp(b.y, 10, H - 10);
  }

  // 자원 리스폰
  if (room.respawns.length) {
    const remain = [];
    for (const r of room.respawns) { if (r.at <= t) spawnNode(room, r.type, r.zone); else remain.push(r); }
    room.respawns = remain;
  }
  // 희귀 보석 (밤에 더 자주)
  room.gemTimer -= dt;
  if (room.gemTimer <= 0) {
    const gems = room.nodes.filter((n) => n.type === 'gem').length;
    if (night) { room.gemTimer = 6; if (gems < 16 && Math.random() < 0.7) spawnNode(room, 'gem', pick(['mine', 'mine', 'hazard', 'hazard', 'ruins'])); }
    else { room.gemTimer = 20; if (gems < 8 && Math.random() < 0.5) spawnNode(room, 'gem', pick(['mine', 'hazard', 'ruins'])); }
  }
  // 만료된 보물상자
  if (room.nodes.some((n) => n.expires && n.expires <= t)) {
    room.nodes = room.nodes.filter((n) => !(n.expires && n.expires <= t));
    room.nodesDirty = true;
  }
  // 만료된 요청
  for (const [k, r] of room.trades) if (r.at + 30 <= t) { room.trades.delete(k); const f = room.players.get(r.from); if (f) sendTo(f, 'tradeEnd', { id: k }); const o = room.players.get(r.to); if (o) sendTo(o, 'tradeEnd', { id: k }); }
  for (const [k, r] of room.allyReqs) if (r.at + 30 <= t) room.allyReqs.delete(k);

  // 1초마다: 미션 알림 / 접속 끊김 처리
  room.secTimer += dt;
  if (room.secTimer >= 1) {
    room.secTimer = 0;
    for (const p of players) {
      if (!p.missionNotified && p.alive && p.mission.id !== 'survive' && missionProgress(p, false).done) {
        p.missionNotified = true;
        toast(p, '🎯 비밀 미션 달성! (+200점)', 'good');
      }
    }
  }

  // 탈출선
  const sh = room.ship;
  if (sh.active && !sh.departed) {
    if (!sh.fullAt && sh.boarded.length >= sh.seats) { sh.fullAt = t; sh.departAt = Math.min(sh.departAt, t + 8); logAll(room, '⛵ 탈출선 자리가 가득 찼어! 곧 출발해!'); }
    const stillOut = players.some((p) => p.alive && !p.boarded);
    if (!stillOut && !sh.fullAt) { sh.fullAt = t; sh.departAt = Math.min(sh.departAt, t + 5); }
    if (t >= sh.departAt) { sh.departed = true; logAll(room, '🚢 탈출선이 출발했다!'); endGame(room, 'ship'); return; }
  }
  if (t >= DURATION) { endGame(room, 'time'); return; }
  if (!players.some((p) => p.alive)) { endGame(room, 'dead'); return; }

  broadcast(room, night, ev);
}

function visionOf(room, p, night) {
  if (!p.alive) return Infinity;
  let v = night ? 220 : 700;
  if (room.event && room.event.type === 'fog') v = Math.min(v, 170);
  return v;
}
function broadcast(room, night, ev) {
  const t = room.t;
  if (room.nodesDirty) { io.to(room.code).emit('nodes', nodesList(room)); room.nodesDirty = false; }
  const sh = room.ship;
  const common = {
    t: +t.toFixed(1), phase: night ? 'night' : 'day',
    camp: { lv: room.camp.level, pool: room.camp.pool, safe: safeRadius(room) },
    ev: ev ? { type: ev.type, name: EVENT_NAMES[ev.type], left: Math.max(0, Math.ceil(ev.until - t)) } : null,
    ship: { active: sh.active, departed: sh.departed, seats: sh.seats, boarded: sh.boarded.length, left: sh.active ? Math.max(0, Math.ceil(sh.departAt - t)) : 0 },
    meteors: room.meteors.map((m) => ({ x: Math.round(m.x), y: Math.round(m.y), left: +(m.at - t).toFixed(1) })),
    boars: room.boars.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y) })),
    volcano: room.volcanoUntil > t,
  };
  const all = [...room.players.values()];
  for (const p of all) {
    if (!p.connected || !p.sid) continue;
    const vis = visionOf(room, p, night);
    const players = all.map((q) => {
      const o = {
        id: q.pid, n: q.name, e: q.emoji, hp: Math.ceil(q.hp), a: q.alive ? 1 : 0, on: q.connected ? 1 : 0,
        bt: Math.max(0, Math.ceil(q.betrayerUntil - t)), bd: q.boarded ? 1 : 0, al: p.allies.has(q.pid) ? 1 : 0,
        sh: q.shieldUntil > t ? 1 : 0,
      };
      if (q.alive && (q.pid === p.pid || p.allies.has(q.pid) || !p.alive || dist(p.x, p.y, q.x, q.y) <= vis)) {
        o.x = Math.round(q.x); o.y = Math.round(q.y);
      }
      return o;
    });
    const mp = missionProgress(p, false);
    const sc = scoreParts(room, p, false);
    const data = Object.assign({}, common, {
      players,
      me: {
        inv: p.inv, score: sc.total, hp: Math.ceil(p.hp),
        mission: { text: p.mission.text, cur: mp.cur, goal: mp.goal, done: mp.done },
        shieldLeft: Math.max(0, Math.ceil(p.shieldUntil - t)), hookCd: Math.max(0, Math.ceil(p.hookCd - t)),
        allies: [...p.allies],
      },
      traps: room.traps.filter((x) => x.owner === p.pid || p.allies.has(x.owner)).map((x) => ({ x: Math.round(x.x), y: Math.round(x.y), mine: x.owner === p.pid ? 1 : 0 })),
    });
    io.to(p.sid).volatile.emit('state', data);
  }
}

// ---------------- 플레이어 행동 ----------------
function addRes(p, k, n) { p.inv[k] = Math.min(99, p.inv[k] + n); }
function nearCamp(p) { return dist(p.x, p.y, CAMP.x, CAMP.y) <= 150; }

function act(room, p, d) {
  if (room.state !== 'playing' || !d || typeof d !== 'object') return;
  const t = room.t;
  if (!p.alive) return;
  if (p.boarded) return toast(p, '이미 탑승했어! 출발을 기다리자 ⛵');
  switch (d.type) {
    case 'collect': {
      if (t < p.collectCd) return;
      let best = null, bd = 75;
      for (const n of room.nodes) { const dd = dist(p.x, p.y, n.x, n.y); if (dd < bd) { bd = dd; best = n; } }
      if (!best) return toast(p, '자원 가까이에서 눌러봐!');
      p.collectCd = t + 0.35;
      removeNode(room, best);
      if (best.type === 'chest') {
        const g = rint(2, 3); addRes(p, 'gem', g); p.stats.gems += g; p.stats.gather += g;
        const parts = [`💎${g}`];
        for (let i = 0; i < 3; i++) { const k = pick(['wood', 'stone', 'food', 'part']); addRes(p, k, 1); p.stats.gather += 1; }
        toast(p, `🎁 보물상자 열림! ${parts.join(' ')} + 자원 3개`, 'good');
      } else {
        const amt = p.inv.axe && (best.type === 'wood' || best.type === 'stone') ? 2 : 1;
        addRes(p, best.type, amt); p.stats.gather += amt;
        if (best.type === 'gem') { p.stats.gems += 1; toast(p, '💎 보석 획득!', 'good'); }
      }
      break;
    }
    case 'craft': {
      const r = RECIPES[d.item];
      if (!r) return;
      if (p.inv[d.item] >= r.max) return toast(p, `${r.name}은(는) 더 가질 수 없어`, 'bad');
      if (!hasBundle(p, Object.assign({ wood: 0, stone: 0, food: 0, part: 0, gem: 0 }, r.cost))) return toast(p, '재료가 부족해!', 'bad');
      for (const k of Object.keys(r.cost)) p.inv[k] -= r.cost[k];
      p.inv[d.item]++; p.stats.crafts++;
      toast(p, `${r.emoji} ${r.name} 제작 완료!`, 'good');
      break;
    }
    case 'eat':
      if (p.inv.food < 1) return toast(p, '음식이 없어!', 'bad');
      if (p.hp >= 100) return toast(p, '이미 체력이 가득해');
      p.inv.food--; p.hp = Math.min(100, p.hp + 20);
      break;
    case 'shield':
      if (p.inv.shield < 1) return toast(p, '방어막이 없어!', 'bad');
      p.inv.shield--; p.shieldUntil = t + 25;
      toast(p, '🔮 25초간 방어막 활성화!', 'good');
      break;
    case 'trap': {
      if (p.inv.trap < 1) return toast(p, '함정이 없어!', 'bad');
      if (dist(p.x, p.y, CAMP.x, CAMP.y) <= safeRadius(room)) return toast(p, '캠프 안에는 설치할 수 없어', 'bad');
      if (room.traps.filter((x) => x.owner === p.pid).length >= 3) return toast(p, '함정은 동시에 3개까지!', 'bad');
      p.inv.trap--;
      room.traps.push({ id: ++room.nid, owner: p.pid, x: p.x, y: p.y, allyAtPlace: new Set(p.allies) });
      toast(p, '🪤 함정을 설치했어 (너와 동맹만 볼 수 있어)', 'good');
      break;
    }
    case 'hook': {
      const v = room.players.get(d.to);
      if (!v || v === p || !v.alive || v.boarded) return;
      if (p.inv.hook < 1) return toast(p, '갈고리가 없어!', 'bad');
      if (t < p.hookCd) return toast(p, '갈고리 재사용 대기 중!', 'bad');
      if (dist(p.x, p.y, v.x, v.y) > 110) return toast(p, '상대가 너무 멀어!', 'bad');
      p.inv.hook--; p.hookCd = t + 10;
      if (v.shieldUntil > t) { toast(p, `🔮 ${v.name} 의 방어막에 막혔어!`, 'bad'); toast(v, `🔮 ${p.name} 의 갈고리를 막아냈어!`, 'good'); break; }
      const wasAlly = p.allies.has(v.pid) || (p.recent.get(v.pid) || 0) > t;
      const r = stealFrom(room, p, v, 3);
      if (!r.got) { toast(p, '훔칠 자원이 없었어...', 'bad'); break; }
      toast(p, `🪝 ${v.name} 에게서 자원 ${r.got}개를 훔쳤어!`, 'good');
      toast(v, `🪝 ${p.name} 이(가) 자원 ${r.got}개를 훔쳐갔어!`, 'bad');
      if (wasAlly) betray(room, p, v, '갈고리');
      break;
    }
    case 'deposit': {
      if (!nearCamp(p)) return toast(p, '캠프 안에서만 넣을 수 있어', 'bad');
      const k = d.res; const n = Math.floor(Number(d.n) || 0);
      if (!RES.includes(k) || n < 1 || n > 99 || p.inv[k] < n) return;
      p.inv[k] -= n; room.camp.pool[k] += n; p.stats.camp += n;
      for (;;) {
        const lv = room.camp.level;
        if (lv >= 5) break;
        const cost = CAMP_COST[lv + 1];
        if (!Object.keys(cost).every((x) => room.camp.pool[x] >= cost[x])) break;
        for (const x of Object.keys(cost)) room.camp.pool[x] -= cost[x];
        room.camp.level++;
        logAll(room, `🏕️ 캠프가 Lv.${room.camp.level} 로 업그레이드됐어!`);
        if (room.camp.level === 5) {
          room.ship.active = true;
          room.ship.departAt = Math.min(t + 75, DURATION - 10);
          logAll(room, `🚢 탈출선 등장! 해변 선착장에서 탑승해! (자리 ${room.ship.seats}개)`);
        }
      }
      break;
    }
    case 'exchange': {
      if (room.camp.level < 3) return toast(p, '캠프 Lv.3부터 상점을 쓸 수 있어', 'bad');
      if (!nearCamp(p)) return toast(p, '캠프 안에서만 가능해', 'bad');
      if (!RES.includes(d.from) || !RES.includes(d.to) || d.from === d.to) return;
      if (p.inv[d.from] < 3) return toast(p, '3개가 필요해!', 'bad');
      p.inv[d.from] -= 3; addRes(p, d.to, 1);
      break;
    }
    case 'board': {
      const sh = room.ship;
      if (!sh.active || sh.departed) return toast(p, '탈출선이 아직 없어!', 'bad');
      if (dist(p.x, p.y, DOCK.x, DOCK.y) > 110) return toast(p, '해변 선착장으로 가!', 'bad');
      if (sh.boarded.length >= sh.seats) return toast(p, '자리가 없어... 😢', 'bad');
      p.boarded = true; sh.boarded.push(p.pid);
      p.x = DOCK.x; p.y = DOCK.y;
      for (const id of p.allies) { const o = room.players.get(id); if (o) o.allies.delete(p.pid); }
      p.allies.clear();
      logAll(room, `⛵ ${p.emoji} ${p.name} 탈출선 탑승! (${sh.boarded.length}/${sh.seats})`);
      break;
    }
    case 'trade': {
      const o = room.players.get(d.to);
      if (!o || o === p || !o.alive || o.boarded) return toast(p, '거래할 수 없는 상대야', 'bad');
      const g = parseBundle(d.give), w = parseBundle(d.want);
      if (!g || !w || g.sum < 1) return toast(p, '거래 내용을 확인해줘', 'bad');
      if (!hasBundle(p, g.b)) return toast(p, '줄 자원이 부족해!', 'bad');
      if (dist(p.x, p.y, o.x, o.y) > 400) return toast(p, '상대와 너무 멀어 (가까이 가자)', 'bad');
      const id = `${p.pid}>${o.pid}`;
      room.trades.set(id, { from: p.pid, to: o.pid, give: g.b, want: w.b, at: t });
      sendTo(o, 'tradeReq', { id, from: p.pid, name: p.name, emoji: p.emoji, give: g.b, want: w.b });
      toast(p, `🔄 ${o.name} 에게 거래를 제안했어`);
      break;
    }
    case 'tradeReply': {
      const tr = room.trades.get(d.id);
      if (!tr || tr.to !== p.pid) return;
      room.trades.delete(d.id);
      const f = room.players.get(tr.from);
      sendTo(p, 'tradeEnd', { id: d.id });
      if (!f) return;
      sendTo(f, 'tradeEnd', { id: d.id });
      if (!d.accept) return toast(f, `❌ ${p.name} 이(가) 거래를 거절했어`, 'bad');
      if (!f.alive || f.boarded) return toast(p, '상대가 거래할 수 없는 상태야', 'bad');
      if (!hasBundle(f, tr.give) || !hasBundle(p, tr.want)) { toast(p, '자원이 부족해서 거래가 취소됐어', 'bad'); toast(f, '자원이 부족해서 거래가 취소됐어', 'bad'); return; }
      if (dist(p.x, p.y, f.x, f.y) > 400) return toast(p, '너무 멀어서 거래할 수 없어', 'bad');
      for (const k of RES) { f.inv[k] += -tr.give[k] + tr.want[k]; p.inv[k] += tr.give[k] - tr.want[k]; f.inv[k] = Math.min(99, f.inv[k]); p.inv[k] = Math.min(99, p.inv[k]); }
      const gsum = RES.reduce((a, k) => a + tr.give[k], 0), wsum = RES.reduce((a, k) => a + tr.want[k], 0);
      if (gsum > 0 && wsum > 0) { f.stats.trades++; p.stats.trades++; }
      if (f.allies.has(p.pid) && gsum > 0 && wsum > 0) {
        const bonus = (recv, who) => {
          const k = RES.reduce((best, x) => (recv[x] > recv[best] ? x : best), RES[0]);
          addRes(who, k, Math.max(1, Math.round(RES.reduce((a, x) => a + recv[x], 0) * 0.2)));
        };
        bonus(tr.want, f); bonus(tr.give, p);
        toast(f, '🤝 동맹 거래 보너스를 받았어!', 'good'); toast(p, '🤝 동맹 거래 보너스를 받았어!', 'good');
      } else { toast(f, '✅ 거래 성공!', 'good'); toast(p, '✅ 거래 성공!', 'good'); }
      break;
    }
    case 'allyReq': {
      const o = room.players.get(d.to);
      if (!o || o === p || !o.alive || o.boarded) return;
      if (p.betrayerUntil > t) return toast(p, '배신자 표식 중에는 동맹을 맺을 수 없어 😈', 'bad');
      if (p.allies.has(o.pid)) return toast(p, '이미 동맹이야');
      if (p.allies.size >= 3 || o.allies.size >= 3) return toast(p, '동맹은 최대 3명까지야', 'bad');
      room.allyReqs.set(`${p.pid}>${o.pid}`, { from: p.pid, to: o.pid, at: t });
      sendTo(o, 'allyReq', { from: p.pid, name: p.name, emoji: p.emoji });
      toast(p, `🤝 ${o.name} 에게 동맹을 제안했어`);
      break;
    }
    case 'allyReply': {
      const key = `${d.from}>${p.pid}`;
      const r = room.allyReqs.get(key);
      if (!r) return;
      room.allyReqs.delete(key);
      const f = room.players.get(d.from);
      if (!f) return;
      if (!d.accept) return toast(f, `❌ ${p.name} 이(가) 동맹을 거절했어`, 'bad');
      if (!f.alive || f.boarded || f.betrayerUntil > t || p.betrayerUntil > t) return toast(p, '지금은 동맹을 맺을 수 없어', 'bad');
      if (f.allies.size >= 3 || p.allies.size >= 3) return toast(p, '동맹은 최대 3명까지야', 'bad');
      f.allies.add(p.pid); p.allies.add(f.pid);
      toast(f, `🤝 ${p.name} 와(과) 동맹 성립!`, 'good'); toast(p, `🤝 ${f.name} 와(과) 동맹 성립!`, 'good');
      logAll(room, `🤝 ${f.emoji}${f.name} + ${p.emoji}${p.name} 동맹!`);
      break;
    }
    case 'allyBreak': {
      const o = room.players.get(d.to);
      if (!o || !p.allies.has(o.pid)) return;
      p.allies.delete(o.pid); o.allies.delete(p.pid);
      p.recent.set(o.pid, t + 10);
      toast(p, `💔 ${o.name} 와(과) 동맹을 해제했어`);
      toast(o, `💔 ${p.name} 이(가) 동맹을 해제했어`, 'bad');
      break;
    }
    default: break;
  }
}

// ---------------- 소켓 ----------------
function getCtx(socket) {
  const room = rooms.get(socket.data.code);
  if (!room) return {};
  return { room, p: room.players.get(socket.data.pid) };
}
function attach(socket, room, p) {
  if (p.sid && p.sid !== socket.id) {
    const old = io.sockets.sockets.get(p.sid);
    if (old) { old.data = {}; old.leave(room.code); old.emit('kicked'); }
  }
  p.sid = socket.id; p.connected = true; p.offlineAt = 0;
  socket.data = { code: room.code, pid: p.pid };
  socket.join(room.code);
}

io.on('connection', (socket) => {
  socket.data = {};
  let win = { n: 0, at: Date.now() };
  const allow = () => {
    const now = Date.now();
    if (now - win.at > 1000) win = { n: 0, at: now };
    return ++win.n <= 60;
  };
  const safe = (fn) => (...args) => {
    try { if (!allow()) return; fn(...args); } catch (e) { console.error(e); }
  };
  const reply = (cb, v) => { if (typeof cb === 'function') cb(v); };

  socket.on('create', safe((d, cb) => {
    if (rooms.size > 300) return reply(cb, { ok: false, error: '서버가 가득 찼어. 잠시 후 다시 해줘!' });
    const room = createRoom();
    const p = addPlayer(room, cleanName(d && d.name));
    attach(socket, room, p);
    reply(cb, { ok: true, code: room.code, pid: p.pid, token: p.token });
    emitLobby(room);
  }));

  socket.on('join', safe((d, cb) => {
    const code = String((d && d.code) || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return reply(cb, { ok: false, error: '그런 방 코드는 없어. 다시 확인해줘!' });
    if (room.state !== 'lobby') return reply(cb, { ok: false, error: '이미 게임이 시작된 방이야.' });
    if (room.players.size >= MAX_PLAYERS) return reply(cb, { ok: false, error: '방이 가득 찼어 (최대 8명).' });
    const p = addPlayer(room, cleanName(d && d.name));
    attach(socket, room, p);
    reply(cb, { ok: true, code: room.code, pid: p.pid, token: p.token });
    emitLobby(room);
  }));

  socket.on('rejoin', safe((d, cb) => {
    const room = d && rooms.get(String(d.code));
    const p = room && room.players.get(String(d.pid));
    if (!room || !p || p.token !== d.token) return reply(cb, { ok: false, error: '이전 방을 찾을 수 없어' });
    attach(socket, room, p);
    reply(cb, { ok: true, code: room.code, pid: p.pid, state: room.state });
    if (room.state === 'lobby') emitLobby(room);
    else {
      socket.emit('started', configOf(room));
      socket.emit('nodes', nodesList(room));
      if (room.state === 'ended' && room.results) socket.emit('ended', Object.assign({}, room.results, { host: room.hostPid }));
    }
  }));

  socket.on('start', safe(() => {
    const { room, p } = getCtx(socket);
    if (!room || !p || room.hostPid !== p.pid || room.state !== 'lobby') return;
    const n = [...room.players.values()].filter((q) => q.connected).length;
    if (n < 2) return toast(p, '2명 이상 모여야 시작할 수 있어!', 'bad');
    startGame(room);
  }));

  socket.on('input', safe((d) => {
    const { room, p } = getCtx(socket);
    if (!room || !p || room.state !== 'playing' || !d) return;
    const x = Number(d.x), y = Number(d.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    p.input = { x: clamp(x, -1, 1), y: clamp(y, -1, 1), at: Date.now() };
  }));

  socket.on('act', safe((d) => {
    const { room, p } = getCtx(socket);
    if (!room || !p) return;
    act(room, p, d);
  }));

  socket.on('chat', safe((d) => {
    const { room, p } = getCtx(socket);
    if (!room || !p || !d) return;
    const text = String(d.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
    if (!text || Date.now() - p.lastChat < 600) return;
    p.lastChat = Date.now();
    const scope = d.scope === 'ally' ? 'ally' : 'all';
    const msg = { name: p.name, emoji: p.emoji, text, scope, ghost: room.state === 'playing' && !p.alive };
    for (const q of room.players.values()) {
      if (!q.sid) continue;
      if (room.state === 'playing') {
        if (!p.alive && q.alive) continue;
        if (scope === 'ally' && q !== p && !p.allies.has(q.pid)) continue;
      }
      io.to(q.sid).emit('chat', msg);
    }
  }));

  socket.on('rematch', safe(() => {
    const { room, p } = getCtx(socket);
    if (!room || !p || room.hostPid !== p.pid || room.state !== 'ended') return;
    room.state = 'lobby'; room.results = null;
    emitLobby(room);
  }));

  socket.on('leave', safe(() => {
    const { room, p } = getCtx(socket);
    if (!room || !p) return;
    socket.leave(room.code);
    socket.data = {};
    p.connected = false; p.sid = null; p.offlineAt = Date.now() - 999999;
    if (room.state === 'lobby') { room.players.delete(p.pid); reassignHost(room); emitLobby(room); }
    else if (room.state === 'playing' && p.alive) killPlayer(room, p, '퇴장');
  }));

  socket.on('disconnect', () => {
    const { room, p } = getCtx(socket);
    if (!room || !p || p.sid !== socket.id) return;
    p.connected = false; p.offlineAt = Date.now(); p.sid = null;
    if (room.state === 'lobby') emitLobby(room);
  });
});

// 정리 작업: 오래 끊긴 플레이어 제거 / 빈 방 삭제
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    let anyOn = false;
    for (const p of [...room.players.values()]) {
      if (p.connected) { anyOn = true; continue; }
      const off = now - p.offlineAt;
      if (room.state === 'lobby' && off > 20000) { room.players.delete(p.pid); reassignHost(room); emitLobby(room); }
      else if (room.state === 'playing' && p.alive && off > 60000) killPlayer(room, p, '접속 끊김');
    }
    if (room.state === 'lobby') reassignHost(room);
    if (!anyOn && now - room.createdAt > 300000 && [...room.players.values()].every((p) => now - p.offlineAt > 300000)) {
      clearInterval(room.loop); rooms.delete(code);
    }
  }
}, 5000);

server.listen(PORT, () => console.log(`친구 배신 게임 서버 실행 중: http://localhost:${PORT}`));
