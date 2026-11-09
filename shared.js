"use strict";
// Shared village state for all bots running from this folder (CJ7, CJ8, CJ9, ...).
// Keeps a registry of structures (so bots never build on top of each other),
// path links, and a mission board that the bots claim work from.
// All writes go through a tiny directory-based lock, so several processes can share one file safely.

const fs = require("fs");
const path = require("path");

const DIR = process.env.SHARED_DIR || path.join(__dirname, "shared");
const FILE = path.join(DIR, "village.json");
const LOCK = path.join(DIR, "lock");
const STALE_CLAIM_MS = 45 * 60 * 1000;
const MAX_FAILS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const empty = () => ({ nextId: 1, center: null, structures: [], missions: [], links: [] });

function load() {
  try { return Object.assign(empty(), JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch (_) { return empty(); }
}

function read() { return load(); } // lock-free snapshot (for dashboard / checks)

async function update(mutator) {
  fs.mkdirSync(DIR, { recursive: true });
  let locked = false;
  for (let i = 0; i < 100 && !locked; i++) {
    try { fs.mkdirSync(LOCK); locked = true; }
    catch (_) {
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10000) fs.rmdirSync(LOCK); } catch (_) {}
      await sleep(60 + Math.random() * 60);
    }
  }
  try {
    const data = load();
    const result = mutator(data);
    const tmp = FILE + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, FILE);
    return result;
  } finally {
    if (locked) { try { fs.rmdirSync(LOCK); } catch (_) {} }
  }
}

// ---------- structures ----------
const overlaps = (a, b, m) =>
  a.x0 - m < b.x0 + b.w && a.x0 + a.w + m > b.x0 && a.z0 - m < b.z0 + b.d && a.z0 + a.d + m > b.z0;

// Atomically reserve a rectangle. Returns the new structure id, or null if it would touch another structure.
function reserve(s, margin = 1) {
  return update((d) => {
    for (const o of d.structures) if (o.status !== "released" && overlaps(s, o, margin)) return null;
    const id = d.nextId++;
    d.structures.push(Object.assign({}, s, { id, status: "building", at: Date.now() }));
    if (!d.center) d.center = { x: s.x0 + Math.floor(s.w / 2), z: s.z0 + Math.floor(s.d / 2), y: s.y };
    return id;
  });
}
function finish(id, extra) {
  return update((d) => { const s = d.structures.find((x) => x.id === id); if (s) { s.status = "done"; Object.assign(s, extra || {}); } });
}
function release(id) {
  return update((d) => { d.structures = d.structures.filter((x) => x.id !== id); });
}
function mark(id, key) {
  return update((d) => { const s = d.structures.find((x) => x.id === id); if (s) s[key] = true; });
}
function addLink(a, b) {
  return update((d) => { d.links.push([a, b]); });
}

// ---------- mission board ----------
function addMissions(list) {
  return update((d) => {
    for (const m of list) d.missions.push(Object.assign({ id: d.nextId++, status: "open", fails: 0, created: Date.now() }, m));
  });
}

// Make sure at least `min` missions are open. makeOne() returns {type,title}.
function seed(min, makeOne) {
  return update((d) => {
    let open = d.missions.filter((m) => m.status === "open").length;
    while (open < min) {
      d.missions.push(Object.assign({ id: d.nextId++, status: "open", fails: 0, created: Date.now() }, makeOne(d)));
      open++;
    }
    // keep the board small: drop old finished missions
    const finished = d.missions.filter((m) => m.status === "done" || m.status === "failed");
    if (finished.length > 30) {
      const drop = new Set(finished.slice(0, finished.length - 30).map((m) => m.id));
      d.missions = d.missions.filter((m) => !drop.has(m.id));
    }
  });
}

// Claim one open mission whose type is in `pool` and which `canRun(mission, data)` accepts.
function claim(bot, pool, canRun) {
  return update((d) => {
    const now = Date.now();
    for (const m of d.missions) if (m.status === "claimed" && now - m.claimedAt > STALE_CLAIM_MS) m.status = "open"; // bot died/stuck
    const ok = d.missions.filter((m) => m.status === "open" && pool.includes(m.type) && canRun(m, d));
    if (!ok.length) return null;
    const m = ok[Math.floor(Math.random() * ok.length)];
    m.status = "claimed"; m.claimedBy = bot; m.claimedAt = now;
    return JSON.parse(JSON.stringify(m));
  });
}
function complete(id, ok, note) {
  return update((d) => {
    const m = d.missions.find((x) => x.id === id);
    if (!m) return;
    if (!ok && note === "interrupted") { m.status = "open"; return; }
    if (ok) { m.status = "done"; m.doneAt = Date.now(); }
    else { m.fails = (m.fails || 0) + 1; m.status = m.fails >= MAX_FAILS ? "failed" : "open"; }
    if (note) m.note = note;
  });
}

module.exports = { read, update, reserve, finish, release, mark, addLink, addMissions, seed, claim, complete, FILE };
