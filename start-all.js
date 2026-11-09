"use strict";
// Starts every bot listed in bots.json as its own process (CJ7, CJ8, CJ9 ...).
// Logins are staggered so Aternos does not throttle the connections.
const { spawn } = require("child_process");
const path = require("path");
const { bots } = require("./bots.json");

const basePort = Number(process.env.PORT) || 5000;
const children = new Map();

function start(bot, i) {
  const child = spawn(process.execPath, [path.join(__dirname, "index.js")], {
    cwd: __dirname,
    env: { ...process.env, BOT_NAME: bot.name, BOT_ROLE: bot.role, PORT: String(basePort + i) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(bot.name, child);
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      let n;
      while ((n = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, n).trimEnd(); buf = buf.slice(n + 1); if (line) console.log(`[${bot.name}] ${line}`); }
    });
  };
  pipe(child.stdout); pipe(child.stderr);
  child.on("exit", (code) => {
    console.log(`[launcher] ${bot.name} exited (${code}) - restarting in 5s`);
    children.delete(bot.name);
    setTimeout(() => start(bot, i), 5000);
  });
  console.log(`[launcher] started ${bot.name} (${bot.role}) - dashboard on port ${basePort + i}`);
}

bots.forEach((bot, i) => setTimeout(() => start(bot, i), (bot.startDelaySec != null ? bot.startDelaySec : i * 25) * 1000));

const killAll = () => { for (const c of children.values()) { try { c.kill("SIGKILL"); } catch (_) {} } };
process.on("exit", killAll);
process.on("SIGINT", () => { killAll(); process.exit(0); });
process.on("SIGTERM", () => { killAll(); process.exit(0); });
