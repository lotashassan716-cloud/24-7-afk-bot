# CJ Builder Bots (CJ7, CJ8, CJ9, CJ10, CJ11)

5 bots that play survival and keep making the Enderlørd server beautiful: houses, big halls, parks, gardens,
gates, stone paths, lamps, walls and furnished homes. Made by Enderlørd — Discord: https://discord.gg/kkfg4MM8

## Run
1. `settings.json` -> `server` (ip / port / version)  [already set to ENDERLORD121.aternos.me:47235]
2. `.env` -> `GEMINI_API_KEY=...` (see `.env.example`)
3. `npm install` then `npm start`  (starts all 5 bots, 25s apart so Aternos does not throttle them)
- Bots and roles live in `bots.json`. Dashboards: CJ7 = port 5000, CJ8 = 5001, CJ9 = 5002, CJ10 = 5003, CJ11 = 5004.
- `http://localhost:5000/missions` shows the shared mission board and everything that has been built.
- `npm run start:single` runs just one bot (set `BOT_NAME=CJ7` and `BOT_ROLE=builder` yourself).

## Roles
- builder (CJ7, CJ10): houses, community hall, gates, furnishing
- decorator (CJ8, CJ11): parks, gardens, stone paths, lamps, gates
- engineer (CJ9): walls, lamps, furnishing, halls, houses

## How it works
Each bot first chops wood, crafts tools, builds its own house and mines stone. After that it takes missions from a
shared board (`shared/village.json`), never builds on top of another bot's work, and signs its buildings
("ENDERLØRD ..."). It also fights mobs, eats, sleeps at night and answers chat with Gemini when someone says its name
(e.g. "cj8 kemon acho?"). Players can say `cj7 help me`, `cj8 build`, `cj9 kath ano`, `cj7 thamo`, `cj8 free`.

## Settings you may want to change (`settings.json` -> `player`)
`baseName` (name on signs), `missions.everyMinutes`, `maxHouses`, `trusted` (who can command the bots), `skinCommand`.
Never upload `.env` to GitHub.
