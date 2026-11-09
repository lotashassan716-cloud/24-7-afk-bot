"use strict";
// "Real player" brain: no owner needed. Chops trees, crafts tools, builds a house with a door,
// mines stone, hunts food, fights mobs, hides/sleeps at night and wanders around - forever.

const fs = require("fs");
const path = require("path");
const { Vec3 } = require("vec3");
const shared = require("./shared");
const missions = require("./missions");

const PROGRESS_FILE = path.join(__dirname, `progress${process.env.BOT_NAME ? "-" + process.env.BOT_NAME : ""}.json`);
const BUILD_ITEMS_PRIORITY = ["_planks", "cobblestone", "stone_bricks", "bricks", "stone", "cobbled_deepslate"];
const SOFT_BLOCKS = ["air", "cave_air", "void_air", "short_grass", "grass", "tall_grass", "fern", "snow", "dead_bush"];
const STONE_NAMES = ["stone", "cobblestone", "andesite", "diorite", "granite"];
const FOOD_ANIMALS = ["cow", "pig", "chicken", "sheep", "rabbit"];
const BAD_FOOD = ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chorus_fruit", "golden_apple", "enchanted_golden_apple"];
const JUNK = ["cobblestone", "dirt", "gravel", "andesite", "diorite", "granite", "cobbled_deepslate", "flint", "rotten_flesh", "spider_eye", "sand", "tuff"];
const ARMOR_TIERS = ["netherite", "diamond", "iron", "chainmail", "golden", "leather"];
const LEATHER_COST = { helmet: 5, chestplate: 8, leggings: 7, boots: 4 };
const TIERS = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function planHouse(x0, y0, z0, size, height) {
  const walls = [];
  const doorX = x0 + Math.floor(size / 2);
  const doorZ = z0 + size - 1;
  for (let dy = 0; dy < height; dy++)
    for (let x = 0; x < size; x++)
      for (let z = 0; z < size; z++) {
        if (!(x === 0 || z === 0 || x === size - 1 || z === size - 1)) continue;
        const wx = x0 + x, wz = z0 + z;
        if (dy < 2 && wx === doorX && wz === doorZ) continue;
        walls.push(new Vec3(wx, y0 + dy, wz));
      }
  const roof = [];
  for (let x = 0; x < size; x++)
    for (let z = 0; z < size; z++)
      roof.push({ p: new Vec3(x0 + x, y0 + height, z0 + z), d: Math.min(x, z, size - 1 - x, size - 1 - z) });
  roof.sort((a, b) => a.d - b.d);
  return { blocks: walls.concat(roof.map((r) => r.p)), doorPos: new Vec3(doorX, y0, doorZ) };
}

function setupSurvivor({ bot, mcData, defaultMove, config, addLog, goals }) {
  const cfg = config.player || {};
  const wanderRadius = cfg.wanderRadius || 30;
  const BASE_NAME = cfg.baseName || "ENDERLØRD";
  const maxHouses = cfg.maxHouses || 10;
  const botName = process.env.BOT_NAME || (config["bot-account"] && config["bot-account"].username) || "CJ";
  const role = cfg.role || "builder";
  const missionsOn = !cfg.missions || cfg.missions.enabled !== false;
  const missionEveryMs = (cfg.missions && cfg.missions.everyMinutes != null ? cfg.missions.everyMinutes : 6) * 60000;
  let lastMission = 0;
  const buildEveryMs = (cfg.buildEveryMinutes || 20) * 60000;
  const trusted = (cfg.trusted || []).map((n) => String(n).toLowerCase());
  const botNames = ((config.ai && config.ai.botNames) || ["cj7"]).map((n) => String(n).toLowerCase());

  let ended = false;
  bot.once("end", () => (ended = true));
  const alive = () => !ended && bot.entity;
  const state = { mode: "free", target: null, modeSince: Date.now(), command: null, interrupt: false };
  const isStop = (e) => e && (e.message === "cancelled" || e.message === "interrupted");
  const guard = () => { if (!alive()) throw new Error("cancelled"); if (state.interrupt) throw new Error("interrupted"); };
  const say = (m) => { try { if (!ended) bot.chat(String(m).slice(0, 250)); } catch (_) {} };

  // ---------- saved progress (survives reconnects/restarts) ----------
  let prog = { done: {}, home: null, houses: [], lastBuild: 0 };
  try { prog = Object.assign(prog, JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"))); } catch (_) {}
  if ((!prog.houses || !prog.houses.length) && prog.home) prog.houses = [prog.home];
  if (!prog.houses) prog.houses = [];
  const save = () => { try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(prog)); } catch (_) {} };
  const home = () => {
    if (!prog.houses.length) return null;
    let best = prog.houses[0], bd = Infinity;
    for (const h of prog.houses) {
      const d = bot.entity ? bot.entity.position.distanceTo(new Vec3(h.x, h.y, h.z)) : 0;
      if (d < bd) { bd = d; best = h; }
    }
    return new Vec3(best.x, best.y, best.z);
  };

  // ---------- basic helpers ----------
  const isSolid = (b) => b && b.boundingBox === "block";
  const isSoft = (b) => !b || SOFT_BLOCKS.includes(b.name);
  const invCount = (pred) => bot.inventory.items().filter(pred).reduce((s, i) => s + i.count, 0);
  const hasItem = (pred) => bot.inventory.items().some(pred);

  async function goto(goal, timeoutMs = 25000) {
    bot.pathfinder.setMovements(defaultMove);
    let timer;
    const timeout = new Promise((_, rej) => (timer = setTimeout(() => { try { bot.pathfinder.stop(); } catch (_) {} rej(new Error("path timeout")); }, timeoutMs)));
    try { await Promise.race([bot.pathfinder.goto(goal), timeout]); } finally { clearTimeout(timer); }
  }

  async function equipTool(kind) {
    for (const tier of TIERS) {
      const it = bot.inventory.items().find((i) => i.name === `${tier}_${kind}`);
      if (it) { try { await bot.equip(it, "hand"); } catch (_) {} return true; }
    }
    return false;
  }

  function bestBuildItem() {
    let best = null;
    for (const key of BUILD_ITEMS_PRIORITY)
      for (const it of bot.inventory.items().filter((i) => (key.startsWith("_") ? i.name.endsWith(key) : i.name === key))) {
        const total = invCount((i) => i.name === it.name);
        if (!best || total > best.total) best = { name: it.name, total };
      }
    return best;
  }

  function plankSpecies() {
    const p = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
    return p ? p.name.replace("_planks", "") : "oak";
  }
  function bestPlanks() {
    let best = null;
    for (const it of bot.inventory.items().filter((i) => i.name.endsWith("_planks"))) {
      const total = invCount((i) => i.name === it.name);
      if (!best || total > best.total) best = { name: it.name, total };
    }
    return best ? best.name : "oak_planks";
  }

  async function tidyInventory() {
    for (const it of bot.inventory.items()) {
      if (JUNK.includes(it.name)) {
        const total = invCount((i) => i.name === it.name);
        if (total > 64) { try { await bot.toss(it.type, null, Math.min(it.count, total - 64)); } catch (_) {} }
      }
    }
  }

  // ---------- gathering ----------
  async function collect(matchFn, amount, toolKind, label, exposedOnly = false) {
    let got = 0, fails = 0, relocates = 0;
    const bad = new Set();
    const exposed = (p) => [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]].some(([x,y,z]) => isSoft(bot.blockAt(p.offset(x, y, z))));
    while (got < amount && fails < 12) {
      guard();
      const found = bot.findBlocks({ matching: (b) => matchFn(b), maxDistance: 48, count: 40 })
        .filter((p) => !bad.has(p.toString()) && (!exposedOnly || exposed(p)))
        .sort((a, b) => (label === "log" ? a.y - b.y : 0) || bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
      if (!found.length) {
        if (++relocates > 4) return got;
        await wander(35).catch(() => {});
        continue;
      }
      const p = found[0];
      try {
        await goto(new goals.GoalNear(p.x, p.y, p.z, 2));
        const block = bot.blockAt(p);
        if (!block || !matchFn(block)) continue;
        if (!bot.canDigBlock(block)) { bad.add(p.toString()); fails++; continue; }
        if (toolKind) await equipTool(toolKind);
        await bot.dig(block);
        got++;
        await goto(new goals.GoalNear(p.x, p.y, p.z, 1), 8000).catch(() => {});
        await sleep(200);
      } catch (e) {
        if (isStop(e)) throw e;
        bad.add(p.toString()); fails++;
      }
    }
    return got;
  }
  const chop = (n) => collect((b) => b && b.name.endsWith("_log"), n, "axe", "log");
  const mineStone = (n) => collect((b) => b && STONE_NAMES.includes(b.name), n, "pickaxe", "stone", true);

  async function wander(radius = wanderRadius) {
    const base = home() || bot.entity.position;
    const x = Math.floor(base.x + rnd(-radius, radius)), z = Math.floor(base.z + rnd(-radius, radius));
    await goto(new goals.GoalXZ(x, z), 30000);
  }

  // ---------- crafting ----------
  async function craftPlanks() {
    for (const it of bot.inventory.items().filter((i) => i.name.endsWith("_log"))) {
      const planks = mcData.itemsByName[it.name.replace("_log", "_planks")];
      const r = planks && bot.recipesFor(planks.id, null, 1, null)[0];
      if (r) { try { await bot.craft(r, it.count, null); } catch (_) {} }
    }
  }

  async function ensureTable() {
    const tableId = mcData.blocksByName.crafting_table.id;
    let t = bot.findBlock({ matching: tableId, maxDistance: 24 });
    if (!t) {
      if (!hasItem((i) => i.name === "crafting_table")) {
        await craftPlanks();
        const it = mcData.itemsByName.crafting_table;
        const r = bot.recipesFor(it.id, null, 1, null)[0];
        if (!r) return null;
        await bot.craft(r, 1, null);
      }
      const feet = bot.entity.position.floored();
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const pos = feet.offset(dx, 0, dz);
        if (isSoft(bot.blockAt(pos)) && isSolid(bot.blockAt(pos.offset(0, -1, 0)))) {
          if (await placeBlockAt(pos, "crafting_table")) break;
        }
      }
      t = bot.findBlock({ matching: tableId, maxDistance: 8 });
    }
    if (t && bot.entity.position.distanceTo(t.position) > 3.5) await goto(new goals.GoalNear(t.position.x, t.position.y, t.position.z, 2), 15000);
    return t;
  }

  async function craft(name, count = 1, needTable = true) {
    const item = mcData.itemsByName[name];
    if (!item) return false;
    try {
      const table = needTable ? await ensureTable() : null;
      if (needTable && !table) return false;
      const r = bot.recipesFor(item.id, null, 1, table)[0];
      if (!r) return false;
      await bot.craft(r, count, table);
      return true;
    } catch (e) { addLog(`[Player] craft ${name} failed: ${e.message}`); return false; }
  }

  async function craftTools(material) {
    // material: "wooden" or "stone"
    for (const tool of ["pickaxe", "axe", "sword"]) {
      if (hasItem((i) => i.name === `${material}_${tool}`)) continue;
      if (material === "wooden") { await craftPlanks(); await craft("stick", 1, false); await craft("stick", 1, false); }
      else if (!hasItem((i) => i.name === "stick")) await craft("stick", 1, false);
      await craft(`${material}_${tool}`);
    }
  }

  // ---------- building ----------
  async function placeBlockAt(pos, itemName) {
    const existing = bot.blockAt(pos);
    if (existing && !isSoft(existing) && !itemName.endsWith("_door")) return true;
    const feet = bot.entity.position.floored();
    if (feet.x === pos.x && feet.z === pos.z && (feet.y === pos.y || feet.y + 1 === pos.y))
      await goto(new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 2)), 8000).catch(() => {});
    if (bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.3) {
      const high = pos.y + 0.5 - (bot.entity.position.y + 1.62) > 2;
      await goto(new goals.GoalNear(pos.x, pos.y, pos.z, high ? 2 : 3), 15000);
    }
    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) throw new Error("out of blocks");
    await bot.equip(item, "hand");
    const faces = [new Vec3(0,-1,0), new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1), new Vec3(0,1,0)];
    for (const f of faces) {
      const ref = bot.blockAt(pos.plus(f));
      if (!isSolid(ref)) continue;
      try {
        await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(ref, f.scaled(-1));
        await sleep(120);
        return true;
      } catch (_) {}
    }
    return false;
  }

  function findSite(center, size, height) {
    const g = Math.floor(center.y);
    const offsets = [[4,-2],[-4-size,-2],[-2,4],[-2,-4-size],[6,4],[-6-size,4],[8,-8],[-8-size,-8],[10,6],[-10-size,6]]
      .sort(() => Math.random() - 0.5);
    for (const [dx, dz] of offsets) {
      const x0 = Math.floor(center.x) + dx, z0 = Math.floor(center.z) + dz;
      let ok = true;
      for (let x = 0; x < size && ok; x++)
        for (let z = 0; z < size && ok; z++) {
          if (!isSolid(bot.blockAt(new Vec3(x0 + x, g - 1, z0 + z)))) ok = false;
          for (let y = 0; y <= height && ok; y++) if (!isSoft(bot.blockAt(new Vec3(x0 + x, g + y, z0 + z)))) ok = false;
        }
      if (ok) return { x0, y0: g, z0 };
    }
    return null;
  }

  async function placeSign(site, plan, n) {
    try {
      await craftPlanks();
      if (!hasItem((i) => i.name.endsWith("_sign"))) await craft(`${plankSpecies()}_sign`, 1);
      const sign = bot.inventory.items().find((i) => i.name.endsWith("_sign"));
      if (!sign) return;
      const ref = bot.blockAt(new Vec3(plan.doorPos.x + 1, site.y0 + 1, plan.doorPos.z)); // wall beside the door
      if (!isSolid(ref)) return;
      await goto(new goals.GoalNear(ref.position.x, ref.position.y, ref.position.z + 2, 1), 15000).catch(() => {});
      await bot.equip(sign, "hand");
      await bot.lookAt(ref.position.offset(0.5, 0.5, 1), true);
      await bot.placeBlock(ref, new Vec3(0, 0, 1));
      await sleep(500);
      const sb = bot.blockAt(ref.position.offset(0, 0, 1));
      if (sb && sb.name.includes("sign")) await bot.updateSign(sb, `${BASE_NAME}\nBase #${n}\nEnderlørd`);
    } catch (e) { addLog("[Player] sign failed: " + e.message); }
  }

  // center: where to build around (null = around the bot). forced: {size,height} to override the random design.
  async function buildHouse(center, forced) {
    const size = (forced && forced.size) || [5, 5, 7][rnd(0, 2)];
    const height = (forced && forced.height) || [3, 3, 4][rnd(0, 2)];
    let site = null, rid = null;
    for (let tries = 0; tries < 8 && !rid; tries++) {
      site = findSite(center || bot.entity.position, size, height);
      if (site) {
        rid = await shared.reserve({ type: "house", x0: site.x0, z0: site.z0, w: size, d: size, y: site.y0, by: botName });
        if (!rid) site = null;
      }
      if (!rid) {
        if (forced) return false;
        addLog("[Player] No free flat spot here - exploring for one");
        center = null;
        await wander(40).catch(() => {});
        guard();
      }
    }
    if (!rid) return false;
    let ok = false;
    try { ok = await buildHouseAt(site, size, height); return ok; }
    finally { if (ok) await shared.finish(rid, { name: `${BASE_NAME} House` }); else await shared.release(rid); }
  }

  async function buildHouseAt(site, size, height) {
    const plan = planHouse(site.x0, site.y0, site.z0, size, height);
    const need = plan.blocks.length;
    const n = prog.houses.length + 1;
    addLog(`[Player] Building ${BASE_NAME} house #${n} at ${site.x0},${site.y0},${site.z0} (${size}x${size}, ${need} blocks)`);

    let best = bestBuildItem();
    if (!best || best.total < need) {
      const logs = Math.ceil((need - (best ? best.total : 0)) / 4) + 2;
      addLog(`[Player] Need wood: chopping ${logs} logs`);
      await chop(logs);
      await craftPlanks();
      best = bestBuildItem();
      if (!best || best.total < need) { addLog("[Player] Not enough blocks yet, will retry later"); return false; }
    }

    let pending = plan.blocks.slice();
    for (let pass = 0; pass < 3 && pending.length; pass++) {
      const failed = [];
      for (const pos of pending) {
        guard();
        try { if (!(await placeBlockAt(pos, best.name))) failed.push(pos); }
        catch (e) { if (isStop(e)) throw e; if (e.message === "out of blocks") return false; failed.push(pos); }
      }
      pending = failed;
    }

    try {
      await craftPlanks();
      if (!hasItem((i) => i.name.endsWith("_door"))) await craft(`${plankSpecies()}_door`, 1);
      const door = bot.inventory.items().find((i) => i.name.endsWith("_door"));
      if (door) await placeBlockAt(plan.doorPos, door.name);
    } catch (e) { addLog("[Player] door failed: " + e.message); }

    await placeSign(site, plan, n);

    const c = new Vec3(site.x0 + Math.floor(size / 2), site.y0, site.z0 + Math.floor(size / 2));
    prog.houses.push({ x: c.x, y: c.y, z: c.z, size, name: `${BASE_NAME} #${n}` });
    if (!prog.home) prog.home = { x: c.x, y: c.y, z: c.z };
    prog.lastBuild = Date.now();
    save();
    addLog(`[Player] ${BASE_NAME} house #${n} done at ${c.x},${c.y},${c.z}`);
    say(`${BASE_NAME} Base #${n} ready!`);
    return true;
  }

  // ---------- armor (the bot\'s "outfit") ----------
  const armorRank = (n) => ARMOR_TIERS.findIndex((t) => n.startsWith(t + "_"));
  async function equipArmor() {
    for (const [suf, dest] of [["helmet", "head"], ["chestplate", "torso"], ["leggings", "legs"], ["boots", "feet"]]) {
      const cur = bot.inventory.slots[bot.getEquipmentDestSlot(dest)];
      const best = bot.inventory.items().filter((i) => i.name.endsWith("_" + suf) && armorRank(i.name) >= 0)
        .sort((a, b) => armorRank(a.name) - armorRank(b.name))[0];
      if (best && (!cur || armorRank(best.name) < armorRank(cur.name))) { try { await bot.equip(best, dest); } catch (_) {} }
    }
  }
  async function craftLeatherArmor() {
    for (const [piece, cost] of Object.entries(LEATHER_COST)) {
      const worn = Object.values(bot.inventory.slots).some((i) => i && i.name.endsWith("_" + piece));
      if (!worn && invCount((i) => i.name === "leather") >= cost) await craft("leather_" + piece);
    }
    await equipArmor();
  }

  // ---------- survival ----------
  async function eatIfNeeded() {
    if (bot.food >= 15) return false;
    const food = bot.inventory.items().find((i) => mcData.foodsByName && mcData.foodsByName[i.name] && !BAD_FOOD.includes(i.name));
    if (!food) return false;
    try { await bot.equip(food, "hand"); await bot.consume(); return true; } catch (_) { return false; }
  }

  async function hunt() {
    const target = Object.values(bot.entities)
      .filter((e) => e.name && FOOD_ANIMALS.includes(e.name) && e.position && bot.entity.position.distanceTo(e.position) < 48)
      .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
    if (!target) { await wander(40).catch(() => {}); return false; }
    await equipTool("sword");
    const start = Date.now();
    let last = target.position.clone();
    while (alive() && !state.interrupt && bot.entities[target.id] && Date.now() - start < 25000) {
      last = target.position.clone();
      const d = bot.entity.position.distanceTo(target.position);
      if (d > 3) { try { bot.pathfinder.setMovements(defaultMove); bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true); } catch (_) {} await sleep(400); }
      else { try { await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true); bot.attack(target); } catch (_) {} await sleep(650); }
    }
    try { bot.pathfinder.setGoal(null); await goto(new goals.GoalNear(last.x, last.y, last.z, 1), 8000); } catch (_) {}
    await sleep(500);
    return true;
  }

  // defend against hostile mobs like a player would
  let lastHit = 0;
  const defense = setInterval(() => {
    if (!alive()) return clearInterval(defense);
    const now = Date.now();
    if (now - lastHit < 650) return;
    const mob = Object.values(bot.entities).find((e) =>
      e !== bot.entity && e.position && (e.type === "hostile" || e.kind === "Hostile mobs") &&
      bot.entity.position.distanceTo(e.position) < 4);
    if (!mob) return;
    lastHit = now;
    try { equipTool("sword"); bot.lookAt(mob.position.offset(0, mob.height * 0.8, 0), true); bot.attack(mob); } catch (_) {}
  }, 300);

  const isNight = () => bot.time && (bot.time.isDay === false || (bot.time.timeOfDay >= 13000 && bot.time.timeOfDay <= 23000));

  async function nightRoutine() {
    const h = home();
    if (!h) return false;
    addLog("[Player] Night - heading home");
    await goto(new goals.GoalNear(h.x, h.y, h.z, 1), 40000).catch(() => {});
    // bed: craft one if we have wool, then sleep
    try {
      const wool = bot.inventory.items().find((i) => i.name.endsWith("_wool") && invCount((x) => x.name === i.name) >= 3);
      if (wool && !hasItem((i) => i.name.endsWith("_bed"))) await craft(wool.name.replace("_wool", "_bed"));
      const bedItem = bot.inventory.items().find((i) => i.name.endsWith("_bed"));
      if (bedItem && !bot.findBlock({ matching: (b) => b.name.endsWith("_bed"), maxDistance: 8 })) {
        const feet = bot.entity.position.floored();
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const pos = feet.offset(dx, 0, dz);
          if (isSoft(bot.blockAt(pos)) && isSolid(bot.blockAt(pos.offset(0, -1, 0))) && (await placeBlockAt(pos, bedItem.name))) break;
        }
      }
      const bed = bot.findBlock({ matching: (b) => b.name.endsWith("_bed"), maxDistance: 8 });
      if (bed) { await bot.sleep(bed); addLog("[Player] Sleeping..."); }
    } catch (_) {}
    // wait for morning, moving a little like a real AFK player
    while (alive() && isNight() && !state.interrupt) {
      await sleep(8000);
      if (bot.isSleeping) continue;
      try { bot.look(Math.random() * Math.PI * 2 - Math.PI, 0, false); } catch (_) {}
      if (Math.random() < 0.2) { bot.setControlState("jump", true); setTimeout(() => { try { bot.setControlState("jump", false); } catch (_) {} }, 300); }
    }
    try { if (bot.isSleeping) await bot.wake(); } catch (_) {}
    return true;
  }

  // ---------- helping players ----------
  const playerEntity = (name) => (bot.players[name] && bot.players[name].entity) || null;

  async function giveTo(name, pred) {
    const e = playerEntity(name);
    if (!e) { say("Tomake dekhte pacchi, kache esho."); return; }
    await goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), 20000).catch(() => {});
    try { await bot.lookAt(e.position.offset(0, e.height * 0.9, 0), true); } catch (_) {}
    for (const it of bot.inventory.items().filter(pred)) { try { await bot.toss(it.type, null, it.count); } catch (_) {} await sleep(300); }
    say("Nao, tomar jonno ene dilam!");
  }

  const REPLIES = {
    follow: "Ok, ashchi! Tomar sathe achi.", stay: "Ok, ekhane achi.", free: "Ok, ami nijer kaj kori.",
    build: "Ok, bari banachi!", wood: "Kath niye ashchi!", stone: "Pathor niye ashchi!", food: "Khabar niye ashchi!",
  };

  function handleCommand(username, message) {
    const m = message.toLowerCase();
    // a player we just offered help to may reply without saying the bot's name
    const offered = state.offer && state.offer.player === username && Date.now() < state.offer.until;
    if (!offered && !botNames.some((n) => m.includes(n))) return false;
    if (trusted.length && !trusted.includes(username.toLowerCase())) return false;
    let t = m;
    for (const n of botNames) t = t.split(n).join(" ");
    const act = /ano|ene\b|dao|\bde\b|chai|\bget\b|bring|collect|fetch|give/.test(t);
    let type = null;
    if (/build|banao|baniye|\bbana\b/.test(t)) type = "build";
    else if (act && /wood|kath|\blogs?\b/.test(t)) type = "wood";
    else if (act && /stone|pathor|cobble/.test(t)) type = "stone";
    else if (act && /food|khabar|khawar/.test(t)) type = "food";
    else if (/\bfree\b|normal|nijer moto|nijer kaj|khelo/.test(t)) type = "free";
    else if (/follow|\bcome\b|\bhelp\b|aso\b|esho|ashi\b|sathe/.test(t)) type = "follow";
    else if (/\bstay\b|\bstop\b|\bwait\b|thamo|thako|dara(o|\b)/.test(t)) type = "stay";
    else if (/status|kothay|ki korcho/.test(t)) type = "status";
    if (!type) return false;
    state.command = { type, player: username };
    state.offer = null;
    state.interrupt = true;
    if (type === "status") {
      const p = bot.entity.position;
      say(`Mode: ${state.mode}, pos ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}, ${BASE_NAME} bari: ${prog.houses.length}`);
    } else say(REPLIES[type]);
    return true;
  }

  async function runCommand(c) {
    const e = playerEntity(c.player);
    switch (c.type) {
      case "follow": state.mode = "follow"; state.target = c.player; state.modeSince = Date.now(); break;
      case "stay": state.mode = "stay"; state.modeSince = Date.now(); try { bot.pathfinder.setGoal(null); } catch (_) {} break;
      case "free": state.mode = "free"; try { bot.pathfinder.setGoal(null); } catch (_) {} break;
      case "build":
        if (!e) { say("Tomake dekhte pacchi, kache esho."); break; }
        await buildHouse(e.position, { size: 5, height: 3 });
        break;
      case "wood": await chop(16); await giveTo(c.player, (i) => i.name.endsWith("_log")); break;
      case "stone": await mineStone(16); await giveTo(c.player, (i) => i.name === "cobblestone"); break;
      case "food":
        for (let k = 0; k < 3; k++) { guard(); await hunt(); }
        await giveTo(c.player, (i) => mcData.foodsByName && mcData.foodsByName[i.name] && !BAD_FOOD.includes(i.name));
        break;
      default: break;
    }
  }

  // ---------- proactive helping: now and then walk up to a player and offer a hand ----------
  const helpEveryMs = (cfg.helpEveryMinutes || 12) * 60000;
  let lastHelp = Date.now();

  async function helpSomeone() {
    const cands = Object.values(bot.players).filter((p) =>
      p.username && p.username !== bot.username && p.entity &&
      (!trusted.length || trusted.includes(p.username.toLowerCase())));
    if (!cands.length) { lastHelp = Date.now() - helpEveryMs + 3 * 60000; return false; } // nobody nearby, retry in ~3 min
    lastHelp = Date.now();
    const p = cands[rnd(0, cands.length - 1)];
    addLog(`[Player] Going to help ${p.username}`);
    await goto(new goals.GoalNear(p.entity.position.x, p.entity.position.y, p.entity.position.z, 3), 30000).catch(() => {});
    say(`Hey ${p.username}! Kono help lagbe? Kath, pathor ba khabar lagle bolo.`);
    state.offer = { player: p.username, until: Date.now() + 90000 };
    const end = Date.now() + 90000;
    while (alive() && Date.now() < end && !state.command && !state.interrupt) {
      const e = playerEntity(p.username);
      if (e) { try { await bot.lookAt(e.position.offset(0, e.height * 0.9, 0), true); } catch (_) {} }
      await sleep(1500);
    }
    if (state.command) return true; // they answered, the command runs next
    state.offer = null;
    // no answer: do a small favour anyway, like a friendly player would
    const gift = [
      ["Kichu kath niye ashlam, kaje lagbe!", async () => { await chop(12); return (i) => i.name.endsWith("_log"); }],
      ["Kichu pathor niye ashlam, kaje lagbe!", async () => { await mineStone(16); return (i) => i.name === "cobblestone"; }],
      ["Kichu khabar niye ashlam, kheye nao!", async () => { for (let k = 0; k < 2; k++) { guard(); await hunt(); } return (i) => mcData.foodsByName && mcData.foodsByName[i.name] && !BAD_FOOD.includes(i.name); }],
    ][rnd(0, 2)];
    const pred = await gift[1]();
    if (playerEntity(p.username)) { await giveTo(p.username, pred); }
    return true;
  }

  const ctx = {
    bot, mcData, goals, addLog, say, goto, placeBlockAt, collect, chop, mineStone, craft, craftPlanks, equipTool,
    guard, isStop, hasItem, invCount, isSolid, isSoft, buildHouse, plankSpecies, bestPlanks,
    BASE_NAME, botName, role, maxHouses,
  };

  let lostSince = 0;

  // ---------- the main brain loop ----------
  async function step() {
    await eatIfNeeded();
    await tidyInventory();
    await equipArmor().catch(() => {});

    if (state.command) {
      const c = state.command; state.command = null; state.interrupt = false;
      try { await runCommand(c); } catch (e) { if (e.message !== "interrupted") throw e; }
      return;
    }
    state.interrupt = false;

    if (state.mode === "stay") {
      if (Date.now() - state.modeSince > 10 * 60000) { state.mode = "free"; return; }
      await sleep(3000); return;
    }
    if (state.mode === "follow") {
      const e = playerEntity(state.target);
      if (e) {
        lostSince = 0;
        if (!bot.pathfinder.goal) { bot.pathfinder.setMovements(defaultMove); bot.pathfinder.setGoal(new goals.GoalFollow(e, 3), true); }
        await sleep(1500); return;
      }
      if (!lostSince) lostSince = Date.now();
      if (Date.now() - lostSince > 120000) { state.mode = "free"; lostSince = 0; return; }
      await sleep(2000); return;
    }

    if (isNight() && home()) return nightRoutine();

    if (bot.food < 12 && !hasItem((i) => mcData.foodsByName && mcData.foodsByName[i.name] && !BAD_FOOD.includes(i.name))) { await hunt(); return; }

    if (!prog.done.wood) {
      addLog("[Player] Stage 1: getting wood + wooden tools");
      await chop(6);
      await craftPlanks();
      await craftTools("wooden");
      prog.done.wood = true; save(); return;
    }
    if (!prog.done.house) {
      if (await buildHouse(null)) { prog.done.house = true; save(); } else await sleep(5000);
      return;
    }
    if (!prog.done.stone) {
      addLog("[Player] Stage 3: mining stone + stone tools");
      const got = await mineStone(14);
      if (got >= 3) await craftTools("stone");
      prog.done.stone = true; save(); return;
    }

    if (invCount((i) => i.name === "leather") >= 4) await craftLeatherArmor().catch(() => {});

    // missions: build houses, parks, buildings and other things that make the server beautiful
    if (missionsOn && Date.now() - lastMission > missionEveryMs) {
      const m = await missions.next(ctx);
      if (!m) { lastMission = Date.now() - missionEveryMs + 90000; }
      else {
        addLog(`[Mission] ${botName} (${role}) starts: ${m.title}`);
        let ok = false, note = "";
        try { ok = await missions.run(m, ctx); }
        catch (e) {
          if (isStop(e)) { await shared.complete(m.id, false, "interrupted"); throw e; }
          note = e.message; addLog(`[Mission] ${m.type} failed: ${e.message}`);
        }
        await shared.complete(m.id, ok, note);
        lastMission = Date.now();
        addLog(`[Mission] ${m.type} ${ok ? "completed" : "not finished (will retry later)"}`);
        return;
      }
    }

    // every so often, go help a player on the server
    if (cfg.helpPlayers !== false && Date.now() - lastHelp > helpEveryMs) { await helpSomeone(); return; }

    // free-play: do human-like things forever
    const r = Math.random();
    if (r < 0.25) { addLog("[Player] Chopping some trees"); await chop(rnd(4, 10)); await craftPlanks(); }
    else if (r < 0.45) { addLog("[Player] Mining stone"); await mineStone(rnd(8, 20)); }
    else if (r < 0.60) { addLog("[Player] Looking for food"); await hunt(); }
    else if (r < 0.85) { addLog("[Player] Exploring around"); await wander(); }
    else {
      addLog("[Player] Chilling at home");
      const h = home(); if (h) await goto(new goals.GoalNear(h.x, h.y, h.z, 3), 40000).catch(() => {});
      const end = Date.now() + rnd(20000, 60000);
      while (alive() && !state.interrupt && Date.now() < end) {
        try { bot.look(Math.random() * Math.PI * 2 - Math.PI, (Math.random() - 0.5) * 0.8, false); } catch (_) {}
        if (Math.random() < 0.3) { bot.setControlState("jump", true); setTimeout(() => { try { bot.setControlState("jump", false); } catch (_) {} }, 300); }
        await sleep(rnd(3000, 8000));
      }
    }
  }

  (async () => {
    await sleep(8000); // let auth / world load first
    if (cfg.skinCommand) { say(cfg.skinCommand); await sleep(2000); }
    addLog(`[Player] Brain started. Progress: ${JSON.stringify(prog.done)} home=${JSON.stringify(prog.home)}`);
    let errors = 0;
    while (alive()) {
      try { await step(); errors = 0; }
      catch (e) {
        if (e.message === "cancelled") break;
        if (e.message === "interrupted") { await sleep(300); continue; }
        addLog("[Player] step error: " + e.message);
        errors++;
        try { bot.pathfinder.setGoal(null); } catch (_) {}
        await sleep(Math.min(3000 * errors, 20000));
      }
      await sleep(rnd(1500, 5000));
    }
  })();

  return { planHouse, handleCommand, ctx };
}

module.exports = { setupSurvivor, planHouse };
