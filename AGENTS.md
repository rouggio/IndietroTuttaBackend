# AGENTS.md — IndietroTuttaBackend (Express + Turso + Leaflet)

Web backend + live map + boat panels + OTA host for ESP32 devices.
Prod: `https://indietrotutta.onrender.com`. Local: `node server.js` → `:3000`.

## Stack / entry

- `server.js`: cors + `express.json()` + `public/` static, mounts `gps,health,devices`, then `initDb().then(listen)`. Falls back to in-memory mode if no `TURSO_DATABASE_URL`.
- Deps: `@libsql/client ^0.17.4`, `express ^5.2.1`, `cors`, `dotenv`, `node-fetch`, `nodemon`.
- `config.js` only exports PORT. `.env` (gitignored, required): `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `REDPLOY_HOOK_URL` (note typo REDPLOY). Render env mirrors it.
- `store/db.js`: `getClient()` / `initDb()` creates `devices, gps_points` + 3 gps indexes (`devices` auto-migrates `firmware`, `boat`, `ip` TEXT + `mock` INTEGER columns). No row cap. Connection test `SELECT 1` throws on bad token.
- (Courses/races removed 2026-10-06 — replanning. See root AGENTS.md.)

## Stores (all have in-memory Map fallback when DB missing)

- `deviceStore.js`: `upsertDevice(deviceId,{username,firmware,ip})` preserves `firstSeen` (captures LAN `ip` from heartbeats); `setDeviceMock(deviceId,on)` records assumed mock-GPS state without touching `lastSeen` (no fake live). Username `/^[A-Za-z0-9 ._-]{1,32}$/`, firmware `/^[A-Za-z0-9._-]{1,16}$/`, boat `/^[A-Za-z0-9 ._-]{1,64}$/` (bad values keep old). `renameDevice(deviceId,{username,boat})` edits info without touching `lastSeen` (no fake live). `getDevices()` adds `status: live<90s / idle<10m / offline`. `deleteDevice` also deletes its gps_points.
- `gpsStore.js`: `addPoint({deviceId,username,lat,lon,speed,course,altitude,sats,flagged,timestamp,receivedAt})` flagged→int. `getPoints({date,deviceId,start,end})` — `start/end` ISO range takes precedence over `date` (YYYY-MM-DD on `substr(timestamp,1,10)`), `ORDER BY id ASC`, flagged→bool. `getLatestPoint(deviceId?)`, `getPointCount()`.

## Routes (every new route needs `bruno/*.bru`)

- `GET|POST /health` — heartbeat: `upsertDevice` from `DeviceId`/`Username`/`Firmware-Version` headers (POST also body incl. `fw`), returns `{status, storedPoints, deviceId, heartbeat, serverTime}`. GET also piggybacks `session` (assigned scheduled/live session: id/mode/status/startTime/startOffsetSec/courseVersion/windDir/marks/startLine/finishLine; null when unassigned).
- `gps.js`: `POST /gps` (validate lat/lon numbers, store + upsert device; `simulated` uploads skip Turso into an ephemeral single-point slot), `GET /gps/sim-live?deviceId=` (latest sim point only, no history — refresh picks up upcoming fixes exclusively), `DELETE /gps/flagged` (exact `{uid}` + `DeviceId` header → deletes that flagged point), `GET /gps?date=&deviceId=` or `?start=&end=` + `&flagged=true` (device waypoint flags for course adopter), `GET /gps/latest?deviceId=`, `GET /gps/count`, `GET /gps/days?deviceId=` (days with data + counts for per-boat calendar).
- `templates.js`: `GET /templates/presets` (5 wind-frame presets, no DB), `GET /templates`, `POST /templates` (`{name,desc?,marks[,startLine,finishLine]}` or `{name,template:presetKey}`), `GET/PUT/DELETE /templates/:id` (PUT bumps `version`). Optional line segments `{ax,ay,bx,by,square?,bias?}` (≥5m, square-to-wind default); `finishLine` may be `{sameAs:"start"}`.
- `sessions.js`: sessions encapsulate templates (frozen snapshot, never linked). Status is inferred on read (abandoned sticks; finished when every boat uploaded a run; live once the gun passes; else scheduled) — `PUT` accepts only `abandoned` (or `scheduled` to re-open). `GET /sessions[?date=]`, `POST /sessions` (`{templateId}` or `{snapshot:{marks,startLine?,finishLine?}}` + placement → resolved marks; stamps `templateVersion`), `GET/PUT/DELETE /sessions/:id` (geometry edits re-resolve + bump `courseVersion`), `POST /sessions/:id/repeat` (same frozen shape onto a new day, boats carried over), `POST/DELETE /sessions/:id/boats[/:deviceId]` (participants + pursuit `startOffsetSec`). Run uploads: `POST /sessions/:id/runs` (device finish log `{deviceId,startEpoch,finishEpoch?,splits?,events?,result?}`, re-upload replaces), `GET /sessions/:id/runs` (results, finished first). Committee: `POST /sessions/:id/signals` (`{kind: OCS|DSQ|DNF|RET|SCP|RECALL|ABANDON, deviceId?, detail?}`), `GET /sessions/:id/signals` (log, oldest first).
- `wind.js`: `GET /wind?lat=&lon=` — suggest-only venue wind (WU PWS `WU_API_KEY` → Weathercloud unofficial → Open-Meteo model), 10-min cache; caller freezes value into session.
- `sim.js` (in-memory test rig, lost on restart): `POST /sim/runs {sessionId, deviceId?, speedKn?, startInSec?}` compiles a 1Hz scripted route (hold → gun cross → mark/gate centers → finish, seeded noise), `GET /sim/next?deviceId=` wall-clock delivery, `GET /sim/runs[?sessionId=]`, `DELETE /sim/runs/:id`, `GET /sim/wander?deviceId=` server-driven wander fix (viewport anchor when pushed, else free random walk from last position; 404 with neither), `POST /sim/anchor {lat,lon}` sets the viewport anchor.
- `devices.js` (+ `/boats` alias): `GET /devices`, `GET /boats`, `PUT /devices/:id` / `PUT /boats/:id` rename `{username, boat}` (no heartbeat side effects), `POST /devices/:id/mock` / `POST /boats/:id/mock` `{on:bool}` (proxies to the device portal `/mock` over LAN via stored `ip`, then records `mock`; 409 no known ip, 502 portal unreachable), `DELETE /devices/:id` (+ `/boats/:id`).

## Frontend (`public/`)

- `index.html` + `app.js` + `style.css`, Leaflet 1.9.4 CDN. Topbar: Boats/Wind/Timeline toggles, Live button + preset (today/yesterday/thisWeek/custom) + datetime pickers + recenter.
- Map: polyline tracks + flagged markers, per-boat colored stripes, no-auto-pan (recenter on demand), hover 100m dots, click-to-jump.
- Boat panels (Leaflet controls, draggable): Speed/Course/Time + Boat make-model, header icons ⌖ (center map, keeps zoom) + ⓘ (info modal) + ×. Info modal: read-only Device/Status/Firmware/Last/First seen + editable Boat name + Make/model → `PUT /boats/:id`, list + panels refresh.
- Boats list: filter, status dots + firmware (`v1.0.x` after lastSeen when reported), 📅 per-row sailing-days calendar (active days in boat color → click sets custom day range).
- Races menu (topbar dropdown): Templates panel (5 presets + yours + blank → builder) and Sessions panel (create + committee: start +5:00/postpone/custom start, status, boats + pursuit offsets, repeat onto new day, delete). Panels draggable, positions persisted, auto-cascade on overlap.
- Builder (right panel, map stays visible): templates only. Click-to-drop + draggable marks (type/radius/order, side on roundings only), whole-course Move drag, bottom-left wind dial + `/wind` suggest, scale, lines list (define/drag ends/move, same-as, bias/square), gate auto-pairing + pile badges, waypoint adopter (boat+day → flagged pins → append), live dashed route + naked meter labels (toggle). Drafts in `localStorage`.
- Playback: play/rewind/speed 1–20x, timeline with per-boat tracks + speed overlay, cursor follows nearest real point, live hides timeline.
- `public/ota/latest.txt + firmware.bin` — written by device `make dist`, served static. `favicon.svg` boat icon.

## Bruno / verify / deploy

- `bruno/` mirrors routes: `health/ gps/ devices/` (incl. `devices-rename.bru`, `devices-mock.bru`), `templates/`, `sessions/` (incl. snapshot + repeat), `sim/` (incl. `wander.bru`), `wind/` + `environments/local.bru (:3000)` + `production.bru (onrender)`. Rule: new endpoint → new `.bru`, test both envs.
- Local check: `node server.js` → `curl localhost:3000/health /devices /boats /gps?date=YYYY-MM-DD`; removed routes return 404 (`/courses/*`, `/races`).
- Deploy (`sd`): commit + push `main`, then `POST $REDPLOY_HOOK_URL` (push alone does NOT redeploy), verify `/devices`. OTA publish comes from device repo `make dist` which commits firmware into `public/ota/` here.
- No auth anywhere — identity is `DeviceId` MAC header. Keep validation + username whitelist in sync with firmware.
