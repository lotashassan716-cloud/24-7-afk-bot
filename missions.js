"use strict";
// Missions: things the bots build to make the server beautiful.
// Each bot has a role (builder / decorator / engineer) that decides which missions it picks from the shared board.

const { Vec3 } = require("vec3");
const shared = require("./shared");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const V = (x, y, z) => new Vec3(x, y, z);

const FLOWERS = ["dandelion", "poppy", "azure_bluet", "oxeye_daisy", "cornflower", "allium", "red_tulip", "orange_tulip", "white_tulip", "pink_tulip", "lily_of_the_valley"];
const GROUND = ["grass_block", "dirt", "coarse_dirt", "podzol", "sand", "gravel", "rooted_dirt", "stone", "sandstone", "mycelium"];
const DIGGABLE_PATH = ["grass_block", "dirt", "coarse_dirt", "podzol", "sand", "gravel", "rooted_dirt"];

const ROLE_POOLS = {
  builder: ["house", "building", "gate", "furnish"],
  decorator: ["park", "garden", "path", "lamps", "gate"],
  engineer: ["wall", "furnish", "lamps", "building", "house"],
};

const titles = (base) => ({
  house: `Build a new house in ${base}`,
  building: `Build the big ${base} community hall`,
  gate: `Build a gate arch for ${base}`,
  park: `Make a park for ${base}`,
  garden: `Plant a flower garden in ${base}`,
  path: "Lay a stone path between two buildings",
  lamps: "Light up a building with torches",
  wall: `Build a stone wall around ${base}`,
  furnish: "Furnish a house (chest + crafting table)",
});

// ---------- which missions can run right now ----------
function pairFor(d) {
  const done = d.structures.filter((s) => s.status === "done");
  const linked = (a, b) => d.links.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  let best = null;
  for (const a of done) for (const b of done) {
    if (a.id >= b.id || linked(a.id, b.id)) continue;
    const dist = Math.hypot(a.x0 + a.w / 2 - (b.x0 + b.w / 2), a.z0 + a.d / 2 - (b.z0 + b.d / 2));
    if (dist < 8 || dist > 60) continue;
    if (!best || dist < best.dist) best = { a, b, dist };
  }
  return best;
}

function canRun(m, d, ctx) {
  const done = d.structures.filter((s) => s.status === "done");
  switch (m.type) {
    case "path": return !!pairFor(d);
    case "lamps": return done.some((s) => !s.lit);
    case "furnish": return done.some((s) => s.type === "house" && !s.furnished);
    case "house": return done.filter((s) => s.type === "house").length < (ctx.maxHouses || 10);
    default: return true;
  }
}

// Make sure every role always has a couple of runnable missions waiting, then claim one.
async function next(ctx) {
  const t = titles(ctx.BASE_NAME);
  await shared.update((d) => {
    for (const role of Object.keys(ROLE_POOLS)) {
      const pool = ROLE_POOLS[role];
      const count = () => d.missions.filter((m) => m.status === "open" && pool.includes(m.type) && canRun(m, d, ctx)).length;
      for (let k = count(); k < 2; k++) {
        const options = pool.filter((type) => canRun({ type }, d, ctx));
        if (!options.length) break;
        const type = options[rnd(0, options.length - 1)];
        d.missions.push({ id: d.nextId++, type, title: t[type], status: "open", fails: 0, created: Date.now() });
      }
    }
    const finished = d.missions.filter((m) => m.status === "done" || m.status === "failed");
    if (finished.length > 30) {
      const drop = new Set(finished.slice(0, finished.length - 30).map((m) => m.id));
      d.missions = d.missions.filter((m) => !drop.has(m.id));
    }
  });
  const pool = ROLE_POOLS[ctx.role] || ROLE_POOLS.builder;
  return shared.claim(ctx.botName, pool, (m, d) => canRun(m, d, ctx));
}

async function run(m, ctx) {
  const fn = RUNNERS[m.type];
  if (!fn) return false;
  return fn(ctx, m);
}

// ---------- shared helpers ----------
const planksCount = (ctx) => ctx.invCount((i) => i.name.endsWith("_planks"));
const stoneCount = (ctx) => ctx.invCount((i) => i.name === "cobblestone");

async function ensureStone(ctx, n) {
  const have = stoneCount(ctx);
  if (have < n) await ctx.mineStone(n - have + 4);
  return stoneCount(ctx) >= n;
}
async function ensureWood(ctx, n) {
  await ctx.craftPlanks();
  const have = planksCount(ctx);
  if (have < n) { await ctx.chop(Math.ceil((n - have) / 4) + 1); await ctx.craftPlanks(); }
  return planksCount(ctx) >= n;
}

async function placeAll(ctx, positions, itemName) {
  let pending = positions.slice();
  for (let pass = 0; pass < 3 && pending.length; pass++) {
    const failed = [];
    for (const pos of pending) {
      ctx.guard();
      try { if (!(await ctx.placeBlockAt(pos, itemName))) failed.push(pos); }
      catch (e) { if (ctx.isStop(e) || e.message === "out of blocks") throw e; failed.push(pos); }
    }
    pending = failed;
  }
  return pending.length;
}

function groundY(ctx, x, z, fromY) {
  for (let y = fromY + 2; y >= fromY - 4; y--) {
    const b = ctx.bot.blockAt(V(x, y, z));
    if (b && ctx.isSolid(b) && ctx.isSoft(ctx.bot.blockAt(V(x, y + 1, z)))) return y;
  }
  return null;
}

function isFlat(ctx, x0, z0, w, d, g, h) {
  for (let x = 0; x < w; x++)
    for (let z = 0; z < d; z++) {
      const below = ctx.bot.blockAt(V(x0 + x, g - 1, z0 + z));
      if (!below || !ctx.isSolid(below) || !GROUND.includes(below.name)) return false;
      for (let y = 0; y <= h; y++) if (!ctx.isSoft(ctx.bot.blockAt(V(x0 + x, g + y, z0 + z)))) return false;
    }
  return true;
}

// Walk near the village, find a flat free rectangle and reserve it for ourselves.
async function reserveRect(ctx, type, w, d, h) {
  const snap = shared.read();
  const center = snap.center || { x: ctx.bot.entity.position.x, z: ctx.bot.entity.position.z };
  for (let tries = 0; tries < 10; tries++) {
    const r = 8 + tries * 3;
    try { await ctx.goto(new ctx.goals.GoalXZ(Math.floor(center.x) + rnd(-r, r), Math.floor(center.z) + rnd(-r, r)), 30000); } catch (_) {}
    ctx.guard();
    const base = ctx.bot.entity.position.floored();
    for (let k = 0; k < 14; k++) {
      const x0 = base.x + rnd(-9, 9), z0 = base.z + rnd(-9, 9), g = base.y;
      if (!isFlat(ctx, x0, z0, w, d, g, h)) continue;
      const id = await shared.reserve({ type, x0, z0, w, d, y: g, by: ctx.botName });
      if (id) return { id, x0, y0: g, z0 };
    }
  }
  return null;
}

// reserve -> fn(site) -> finish or release
async function withSite(ctx, type, w, d, h, fn) {
  const site = await reserveRect(ctx, type, w, d, h);
  if (!site) { ctx.addLog(`[Mission] no free flat spot for ${type}`); return false; }
  let name = null;
  try { name = await fn(site); }
  finally {
    if (name) await shared.finish(site.id, { name });
    else await shared.release(site.id);
  }
  if (name) { ctx.say(`${name} ready!`); ctx.addLog(`[Mission] done: ${name} at ${site.x0},${site.y0},${site.z0}`); }
  return !!name;
}

async function placeSignAt(ctx, refPos, face, lines) {
  try {
    if (!ctx.hasItem((i) => i.name.endsWith("_sign"))) {
      await ensureWood(ctx, 8);
      await ctx.craft(`${ctx.plankSpecies()}_sign`, 1);
    }
    const sign = ctx.bot.inventory.items().find((i) => i.name.endsWith("_sign"));
    if (!sign) return;
    const ref = ctx.bot.blockAt(refPos);
    if (!ctx.isSolid(ref)) return;
    await ctx.goto(new ctx.goals.GoalNear(refPos.x + face.x * 2, refPos.y, refPos.z + face.z * 2, 1), 15000).catch(() => {});
    await ctx.bot.equip(sign, "hand");
    await ctx.bot.lookAt(refPos.offset(0.5 + face.x, 0.5, 0.5 + face.z), true);
    await ctx.bot.placeBlock(ref, face);
    await sleep(500);
    const sb = ctx.bot.blockAt(refPos.plus(face));
    if (sb && sb.name.includes("sign")) await ctx.bot.updateSign(sb, lines.join("\n"));
  } catch (e) { ctx.addLog("[Mission] sign failed: " + e.message); }
}

function ringOrder(list, x0, z0, w, d) {
  return list.sort((a, b) => Math.min(a.x - x0, a.z - z0, x0 + w - 1 - a.x, z0 + d - 1 - a.z) - Math.min(b.x - x0, b.z - z0, x0 + w - 1 - b.x, z0 + d - 1 - b.z));
}

// box with a door in the middle of the south wall, optional open "windows", flat roof
function planBox(x0, y0, z0, w, d, h, windows) {
  const walls = [];
  const doorX = x0 + Math.floor(w / 2), doorZ = z0 + d - 1;
  for (let dy = 0; dy < h; dy++)
    for (let x = 0; x < w; x++)
      for (let z = 0; z < d; z++) {
        if (!(x === 0 || z === 0 || x === w - 1 || z === d - 1)) continue;
        const wx = x0 + x, wz = z0 + z;
        if (dy < 2 && wx === doorX && wz === doorZ) continue;
        if (windows && dy === 1 && ((z === 0 || z === d - 1) ? (x % 3 === 1 && x > 0 && x < w - 1 && !(z === d - 1 && Math.abs(wx - doorX) <= 1)) : (z % 3 === 1 && z > 0 && z < d - 1))) continue;
        walls.push(V(wx, y0 + dy, wz));
      }
  const roof = [];
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) roof.push({ x: x0 + x, z: z0 + z });
  ringOrder(roof, x0, z0, w, d);
  return { walls, roof: roof.map((r) => V(r.x, y0 + h, r.z)), doorPos: V(doorX, y0, doorZ) };
}

// ---------- missions ----------
async function mHouse(ctx) {
  const c = shared.read().center;
  if (c) { try { await ctx.goto(new ctx.goals.GoalXZ(Math.floor(c.x) + rnd(-14, 14), Math.floor(c.z) + rnd(-14, 14)), 30000); } catch (_) {} }
  return ctx.buildHouse(null);
}

async function mBuilding(ctx) {
  const w = [7, 9][rnd(0, 1)], d = 7, h = 4;
  return withSite(ctx, "building", w, d, h, async (s) => {
    const plan = planBox(s.x0, s.y0, s.z0, w, d, h, true);
    if (!(await ensureStone(ctx, plan.walls.length + 2))) return null;
    if (!(await ensureWood(ctx, plan.roof.length + 16))) return null;
    ctx.addLog(`[Mission] hall ${w}x${d}: ${plan.walls.length} wall + ${plan.roof.length} roof blocks`);
    await placeAll(ctx, plan.walls, "cobblestone");
    await placeAll(ctx, plan.roof, ctx.bestPlanks());
    try {
      if (!ctx.hasItem((i) => i.name.endsWith("_door"))) await ctx.craft(`${ctx.plankSpecies()}_door`, 1);
      const door = ctx.bot.inventory.items().find((i) => i.name.endsWith("_door"));
      if (door) await ctx.placeBlockAt(plan.doorPos, door.name);
    } catch (e) { ctx.addLog("[Mission] door failed: " + e.message); }
    await placeSignAt(ctx, V(plan.doorPos.x + 2, s.y0 + 1, plan.doorPos.z), V(0, 0, 1), [ctx.BASE_NAME, "Community Hall", "Enderlørd"]);
    return `${ctx.BASE_NAME} Hall`;
  });
}

async function mGate(ctx) {
  return withSite(ctx, "gate", 5, 1, 4, async (s) => {
    if (!(await ensureStone(ctx, 12))) return null;
    const pos = [];
    for (let y = 0; y < 3; y++) pos.push(V(s.x0, s.y0 + y, s.z0), V(s.x0 + 4, s.y0 + y, s.z0));
    for (let x = 0; x < 5; x++) pos.push(V(s.x0 + x, s.y0 + 3, s.z0));
    await placeAll(ctx, pos, "cobblestone");
    await placeSignAt(ctx, V(s.x0, s.y0 + 1, s.z0), V(0, 0, 1), [ctx.BASE_NAME, "Welcome!", "Enderlørd"]);
    return `${ctx.BASE_NAME} Gate`;
  });
}

async function mWall(ctx) {
  const len = [12, 16, 20][rnd(0, 2)];
  const alongX = Math.random() < 0.5;
  const w = alongX ? len : 1, d = alongX ? 1 : len;
  return withSite(ctx, "wall", w, d, 2, async (s) => {
    if (!(await ensureStone(ctx, len * 2 + 2))) return null;
    const pos = [];
    for (let i = 0; i < len; i++) for (let y = 0; y < 2; y++) pos.push(V(s.x0 + (alongX ? i : 0), s.y0 + y, s.z0 + (alongX ? 0 : i)));
    const left = await placeAll(ctx, pos, "cobblestone");
    return left > len / 2 ? null : `${ctx.BASE_NAME} Wall`;
  });
}

async function mPark(ctx, m, size) {
  const s0 = size || [9, 11, 13][rnd(0, 2)];
  const isGarden = s0 <= 7;
  return withSite(ctx, isGarden ? "garden" : "park", s0, s0, 3, async (s) => {
    const mid = Math.floor(s0 / 2);
    const cx = s.x0 + mid, cz = s.z0 + mid;
    // border (cobblestone walls) with a 3-wide entrance in the middle of every side
    const border = [];
    for (let i = 0; i < s0; i++) {
      for (const [x, z, side] of [[i, 0, "h"], [i, s0 - 1, "h"], [0, i, "v"], [s0 - 1, i, "v"]]) {
        if (Math.abs(i - mid) <= 1) continue;
        if (!border.some((p) => p.x === s.x0 + x && p.z === s.z0 + z)) border.push(V(s.x0 + x, s.y0, s.z0 + z));
      }
    }
    if (!(await ensureStone(ctx, border.length + 6))) return null;
    await ctx.craft("cobblestone_wall", Math.ceil(border.length / 6), true);
    // flowers
    try {
      const seen = ctx.bot.findBlocks({ matching: (b) => b && FLOWERS.includes(b.name), maxDistance: 40, count: 1 });
      if (seen.length) await ctx.collect((b) => b && FLOWERS.includes(b.name), isGarden ? 6 : 10, null, "flower");
    } catch (e) { if (ctx.isStop(e)) throw e; }
    // benches
    let benches = false;
    if (!isGarden && (await ensureWood(ctx, 8))) benches = await ctx.craft(`${ctx.plankSpecies()}_stairs`, 1, true);
    // monument: 3-high pillar with a sign
    await ctx.goto(new ctx.goals.GoalNear(cx, s.y0, cz, 2), 20000).catch(() => {});
    await placeAll(ctx, [V(cx, s.y0, cz), V(cx, s.y0 + 1, cz), V(cx, s.y0 + 2, cz)], "cobblestone");
    if (ctx.hasItem((i) => i.name === "torch")) await ctx.placeBlockAt(V(cx, s.y0 + 3, cz), "torch").catch(() => {});
    await placeSignAt(ctx, V(cx, s.y0 + 1, cz), V(0, 0, 1), [ctx.BASE_NAME, isGarden ? "Garden" : "Park", "Enderlørd"]);
    // border walls
    const walls = ringOrder(border.map((p) => ({ x: p.x, z: p.z })), s.x0, s.z0, s0, s0).map((p) => V(p.x, s.y0, p.z));
    await placeAll(ctx, walls, "cobblestone_wall");
    // benches (stairs) around the monument
    if (benches) for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const st = ctx.bot.inventory.items().find((i) => i.name.endsWith("_stairs"));
      if (st) await ctx.placeBlockAt(V(cx + dx, s.y0, cz + dz), st.name).catch(() => {});
    }
    // flowers on grass
    const flowers = ctx.bot.inventory.items().filter((i) => FLOWERS.includes(i.name));
    for (const f of flowers) {
      for (let k = 0; k < f.count; k++) {
        ctx.guard();
        const x = s.x0 + rnd(1, s0 - 2), z = s.z0 + rnd(1, s0 - 2);
        if (Math.abs(x - cx) <= 1 && Math.abs(z - cz) <= 1) continue;
        const below = ctx.bot.blockAt(V(x, s.y0 - 1, z));
        if (below && below.name === "grass_block" && ctx.isSoft(ctx.bot.blockAt(V(x, s.y0, z)))) await ctx.placeBlockAt(V(x, s.y0, z), f.name).catch(() => {});
      }
    }
    return `${ctx.BASE_NAME} ${isGarden ? "Garden" : "Park"}`;
  });
}
const mGarden = (ctx, m) => mPark(ctx, m, 7);

async function mPath(ctx) {
  // pick a pair of unlinked buildings and link them atomically
  const pair = await shared.update((d) => {
    const p = pairFor(d);
    if (!p) return null;
    d.links.push([p.a.id, p.b.id]);
    return { a: p.a, b: p.b };
  });
  if (!pair) return false;
  let ok = false;
  try {
    const door = (s) => ({ x: s.x0 + Math.floor(s.w / 2), z: s.z0 + s.d + 1 });
    const A = door(pair.a), B = door(pair.b);
    const tiles = [];
    const stepX = Math.sign(B.x - A.x), stepZ = Math.sign(B.z - A.z);
    for (let x = A.x; x !== B.x; x += stepX) tiles.push({ x, z: A.z });
    for (let z = A.z; z !== B.z + stepZ && stepZ !== 0; z += stepZ) tiles.push({ x: B.x, z });
    const inside = (t) => shared.read().structures.some((s) => t.x >= s.x0 && t.x < s.x0 + s.w && t.z >= s.z0 && t.z < s.z0 + s.d);
    const todo = tiles.filter((t) => !inside(t));
    if (!(await ensureStone(ctx, todo.length + 4))) return false;
    ctx.addLog(`[Mission] path ${todo.length} tiles between structure #${pair.a.id} and #${pair.b.id}`);
    let laid = 0;
    for (const t of todo) {
      ctx.guard();
      const p = ctx.bot.entity.position;
      if (Math.hypot(p.x - t.x, p.z - t.z) > 4) { try { await ctx.goto(new ctx.goals.GoalXZ(t.x, t.z), 15000); } catch (_) {} }
      const gy = groundY(ctx, t.x, t.z, Math.floor(ctx.bot.entity.position.y));
      if (gy === null) continue;
      const blk = ctx.bot.blockAt(V(t.x, gy, t.z));
      if (!blk || !DIGGABLE_PATH.includes(blk.name)) continue;
      try {
        if (!ctx.bot.canDigBlock(blk)) continue;
        await ctx.equipTool("shovel");
        await ctx.bot.dig(blk);
        if (await ctx.placeBlockAt(V(t.x, gy, t.z), "cobblestone")) laid++;
      } catch (e) { if (ctx.isStop(e) || e.message === "out of blocks") throw e; }
    }
    ok = laid >= Math.max(3, todo.length / 2);
    if (ok) ctx.say(`${ctx.BASE_NAME} te notun path ready!`);
    return ok;
  } finally {
    if (!ok) await shared.update((d) => { d.links = d.links.filter(([a, b]) => !(a === pair.a.id && b === pair.b.id)); });
  }
}

async function ensureTorches(ctx, n) {
  const torches = () => ctx.invCount((i) => i.name === "torch");
  if (torches() >= n) return true;
  let coal = ctx.invCount((i) => i.name === "coal" || i.name === "charcoal");
  if (coal < 2) {
    await ctx.collect((b) => b && (b.name === "coal_ore" || b.name === "deepslate_coal_ore"), 3, "pickaxe", "coal", true);
    coal = ctx.invCount((i) => i.name === "coal" || i.name === "charcoal");
  }
  if (coal < 1) return false;
  if (!ctx.hasItem((i) => i.name === "stick")) { await ensureWood(ctx, 4); await ctx.craft("stick", 1, false); }
  await ctx.craft("torch", Math.min(coal, Math.ceil((n - torches()) / 4)), false);
  return torches() >= Math.min(n, 4);
}

async function mLamps(ctx) {
  const s = await shared.update((d) => {
    const list = d.structures.filter((x) => x.status === "done" && !x.lit);
    if (!list.length) return null;
    const pick = list[rnd(0, list.length - 1)];
    pick.lit = true;
    return JSON.parse(JSON.stringify(pick));
  });
  if (!s) return false;
  let ok = false;
  try {
    if (!(await ensureTorches(ctx, 8))) { ctx.addLog("[Mission] lamps: no coal found"); return false; }
    await ctx.goto(new ctx.goals.GoalXZ(s.x0 + Math.floor(s.w / 2), s.z0 + s.d + 2), 30000).catch(() => {});
    const spots = [[s.x0 - 1, s.z0 - 1], [s.x0 + s.w, s.z0 - 1], [s.x0 - 1, s.z0 + s.d], [s.x0 + s.w, s.z0 + s.d], [s.x0 + Math.floor(s.w / 2) + 2, s.z0 + s.d]];
    let placed = 0;
    for (const [x, z] of spots) {
      ctx.guard();
      await ctx.goto(new ctx.goals.GoalNear(x, s.y, z, 3), 15000).catch(() => {});
      const gy = groundY(ctx, x, z, s.y - 1);
      if (gy === null) continue;
      try { if (await ctx.placeBlockAt(V(x, gy + 1, z), "torch")) placed++; } catch (e) { if (ctx.isStop(e)) throw e; break; }
    }
    ok = placed >= 2;
    if (ok) ctx.say(`${s.name || ctx.BASE_NAME} te lamp lagalam!`);
    return ok;
  } finally {
    if (!ok) await shared.update((d) => { const x = d.structures.find((y) => y.id === s.id); if (x) x.lit = false; });
  }
}

async function mFurnish(ctx) {
  const s = await shared.update((d) => {
    const list = d.structures.filter((x) => x.status === "done" && x.type === "house" && !x.furnished);
    if (!list.length) return null;
    const pick = list[rnd(0, list.length - 1)];
    pick.furnished = true;
    return JSON.parse(JSON.stringify(pick));
  });
  if (!s) return false;
  let ok = false;
  try {
    if (!(await ensureWood(ctx, 14))) return false;
    await ctx.goto(new ctx.goals.GoalNear(s.x0 + Math.floor(s.w / 2), s.y, s.z0 + Math.floor(s.d / 2), 1), 40000);
    if (!ctx.hasItem((i) => i.name === "chest")) await ctx.craft("chest", 1, true);
    if (ctx.hasItem((i) => i.name === "chest")) await ctx.placeBlockAt(V(s.x0 + 1, s.y, s.z0 + 1), "chest");
    const tableId = ctx.mcData.blocksByName.crafting_table.id;
    if (!ctx.bot.findBlock({ matching: tableId, maxDistance: 6 })) {
      if (!ctx.hasItem((i) => i.name === "crafting_table")) await ctx.craft("crafting_table", 1, false);
      if (ctx.hasItem((i) => i.name === "crafting_table")) await ctx.placeBlockAt(V(s.x0 + s.w - 2, s.y, s.z0 + 1), "crafting_table");
    }
    if (ctx.hasItem((i) => i.name === "torch")) await ctx.placeBlockAt(V(s.x0 + s.w - 2, s.y, s.z0 + s.d - 2), "torch").catch(() => {});
    ok = true;
    ctx.say(`${s.name || "Ekta bari"} sajiye dilam!`);
    return true;
  } finally {
    if (!ok) await shared.update((d) => { const x = d.structures.find((y) => y.id === s.id); if (x) x.furnished = false; });
  }
}

const RUNNERS = { house: mHouse, building: mBuilding, gate: mGate, wall: mWall, park: mPark, garden: mGarden, path: mPath, lamps: mLamps, furnish: mFurnish };

module.exports = { next, run, canRun, ROLE_POOLS, titles, planBox, pairFor };
