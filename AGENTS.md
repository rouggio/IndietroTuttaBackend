# AGENTS.md — IndietroTuttaBackend (Express + Turso + Leaflet)

Web backend + live map + boat panels + OTA host for ESP32 devices.
Prod: `https://indietrotutta.onrender.com`. Local: `node server.js` → `:3000`.

## Stack / entry

- `server.js`: cors + `express.json()` + `public/` static, mounts `gps,health,devices`, then `initDb().then(listen)`. Falls back to in-memory mode if no `TURSO_DATABASE_URL`.
- Deps: `@libsql/client ^0.17.4`, `express ^5.2.1`, `cors`, `dotenv`, `node-fetch`, `nodemon`.
- `config.js` only exports PORT. `.env` (gitignored, required): `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `REDPLOY_HOOK_URL` (note typo REDPLOY). Render env mirrors it.
- `store/db.js`: `getClient()` / `initDb()` creates `devices, gps_points` + 3 gps indexes (`devices` auto-migrates `firmware`, `boat` columns). No row cap. Connection test `SELECT 1` throws on bad token.
- (Courses/races removed 2026-10-06 — replanning. See root AGENTS.md.)

## Stores (all have in-memory Map fallback when DB missing)

- `deviceStore.js`: `upsertDevice(deviceId,{username,firmware})` preserves `firstSeen`; username `/^[A-Za-z0-9 ._-]{1,32}$/`, firmware `/^[A-Za-z0-9._-]{1,16}$/`, boat `/^[A-Za-z0-9 ._-]{1,64}$/` (bad values keep old). `renameDevice(deviceId,{username,boat})` edits info without touching `lastSeen` (no fake live). `getDevices()` adds `status: live<90s / idle<10m / offline`. `deleteDevice` also deletes its gps_points.
- `gpsStore.js`: `addPoint({deviceId,username,lat,lon,speed,course,altitude,sats,flagged,timestamp,receivedAt})` flagged→int. `getPoints({date,deviceId,start,end})` — `start/end` ISO range takes precedence over `date` (YYYY-MM-DD on `substr(timestamp,1,10)`), `ORDER BY id ASC`, flagged→bool. `getLatestPoint(deviceId?)`, `getPointCount()`.

## Routes (every new route needs `bruno/*.bru`)

- `GET|POST /health` — heartbeat: `upsertDevice` from `DeviceId`/`Username`/`Firmware-Version` headers (POST also body incl. `fw`), returns `{status, storedPoints, deviceId, heartbeat, serverTime}`.
- `gps.js`: `POST /gps` (validate lat/lon numbers, store + upsert device; accepts waypoint `uid`), `DELETE /gps/flagged` (exact `{uid}` + `DeviceId` header → deletes that flagged point), `GET /gps?date=&deviceId=` or `?start=&end=` + `&flagged=true` (device waypoint flags for course adopter), `GET /gps/latest?deviceId=`, `GET /gps/count`, `GET /gps/days?deviceId=` (days with data + counts for per-boat calendar).
- `courses.js`: `GET /courses/templates` (5 wind-frame presets, no DB), `GET /courses[?templates=1]`, `POST /courses` (`{name,marks}` or `{name,template}`), `GET/PUT/DELETE /courses/:id` (PUT bumps `version`).
- `sessions.js`: `GET /sessions[?date=]`, `POST /sessions` (freeze template on day → resolved marks), `GET/PUT/DELETE /sessions/:id` (geometry edits re-resolve + bump `courseVersion`), `POST /sessions/:id/repeat` (same course onto a new day, boats carried over), `POST/DELETE /sessions/:id/boats[/:deviceId]` (participants + pursuit `startOffsetSec`). No middleman: templates + sessions only.
- `wind.js`: `GET /wind?lat=&lon=` — suggest-only venue wind (WU PWS `WU_API_KEY` → Weathercloud unofficial → Open-Meteo model), 10-min cache; caller freezes value into session.
- `devices.js` (+ `/boats` alias): `GET /devices`, `GET /boats`, `PUT /devices/:id` / `PUT /boats/:id` rename `{username, boat}` (no heartbeat side effects), `DELETE /devices/:id` (+ `/boats/:id`).

## Frontend (`public/`)

- `index.html` + `app.js` + `style.css`, Leaflet 1.9.4 CDN. Topbar: Boats/Timeline toggles, Live button + preset (today/yesterday/thisWeek/custom) + datetime pickers + recenter.
- Map: polyline tracks + flagged markers, per-boat colored stripes, no-auto-pan (recenter on demand), hover 100m dots, click-to-jump.
- Boat panels (Leaflet controls, draggable): Speed/Course/Time + Boat make-model, header icons ⌖ (center map, keeps zoom) + ⓘ (info modal) + ×. Info modal: read-only Device/Status/Firmware/Last/First seen + editable Boat name + Make/model → `PUT /boats/:id`, list + panels refresh.
- Boats list: filter, status dots + firmware (`v1.0.x` after lastSeen when reported), 📅 per-row sailing-days calendar (active days in boat color → click sets custom day range).
- Races menu (topbar dropdown): Templates panel (5 presets + yours + blank → builder) and Sessions panel (create + committee: start +5:00/postpone/custom start, status, boats + pursuit offsets, repeat onto new day, delete). Panels draggable, positions persisted, auto-cascade on overlap.
- Builder (right panel, map stays visible): click-to-drop + draggable marks (type/side/radius/order editors), venue origin picker, wind slider + `/wind` suggest (source/dist/age shown), scale, waypoint adopter (boat+day → flagged pins → append, first sets origin, wind from first two flags), save template, freeze to session (+auto-assign boats). Drafts in `localStorage`.
- Playback: play/rewind/speed 1–20x, timeline with per-boat tracks + speed overlay, cursor follows nearest real point, live hides timeline.
- `public/ota/latest.txt + firmware.bin` — written by device `make dist`, served static. `favicon.svg` boat icon.

## Bruno / verify / deploy

- `bruno/` mirrors routes: `health/ gps/ devices/` (incl. `devices-rename.bru`) + `environments/local.bru (:3000)` + `production.bru (onrender)`. Rule: new endpoint → new `.bru`, test both envs.
- Local check: `node server.js` → `curl localhost:3000/health /devices /boats /gps?date=YYYY-MM-DD`; removed routes return 404 (`/courses/*`, `/races`).
- Deploy (`sd`): commit + push `main`, then `POST $REDPLOY_HOOK_URL` (push alone does NOT redeploy), verify `/devices`. OTA publish comes from device repo `make dist` which commits firmware into `public/ota/` here.
- No auth anywhere — identity is `DeviceId` MAC header. Keep validation + username whitelist in sync with firmware.
