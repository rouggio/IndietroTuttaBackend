# AGENTS.md — IndietroTuttaBackend (Express + Turso + Leaflet)

Web backend + live map + boat panels + OTA host for ESP32 devices.
Prod: `https://indietrotutta.onrender.com`. Local: `node server.js` → `:3000`.

## Stack / entry

- `server.js`: cors + `express.json()` + `public/` static, mounts `gps,health,devices`, then `initDb().then(listen)`. Falls back to in-memory mode if no `TURSO_DATABASE_URL`.
- Deps: `@libsql/client ^0.17.4`, `express ^5.2.1`, `cors`, `dotenv`, `node-fetch`, `nodemon`.
- `config.js` only exports PORT. `.env` (gitignored, required): `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `REDPLOY_HOOK_URL` (note typo REDPLOY). Render env mirrors it.
- `store/db.js`: `getClient()` / `initDb()` creates `devices, gps_points, courses, sessions, session_boats, runs, signals` (+ gps indexes; `devices` migrates `firmware`/`boat`/`ip` TEXT + `mock` INTEGER; `sessions` migrates `windSpeed` REAL). No row cap. Connection test `SELECT 1` throws on bad token.
- (Race program live: `courses` (wind-frame shapes) → `sessions` → scripted `sim` → device race screen. The shape table has been renamed twice (courses → templates → courses); `races` dropped. See root AGENTS.md.)

## Stores (all have in-memory Map fallback when DB missing)

- `deviceStore.js`: `upsertDevice(deviceId,{username,firmware,ip})` preserves `firstSeen` (captures LAN `ip` from heartbeats); `setDeviceMock(deviceId,on)` records assumed mock-GPS state without touching `lastSeen` (no fake live). Username `/^[A-Za-z0-9 ._-]{1,32}$/`, firmware `/^[A-Za-z0-9._-]{1,16}$/`, boat `/^[A-Za-z0-9 ._-]{1,64}$/` (bad values keep old). `renameDevice(deviceId,{username,boat})` edits info without touching `lastSeen` (no fake live). `getDevices()` adds `status: live<90s / idle<10m / offline`. `deleteDevice` also deletes its gps_points.
- `gpsStore.js`: `addPoint({deviceId,username,lat,lon,speed,course,altitude,sats,timestamp,receivedAt})`. `getPoints({date,deviceId,start,end})` — `start/end` ISO range takes precedence over `date` (YYYY-MM-DD on `substr(timestamp,1,10)`), `ORDER BY id ASC`. `getLatestPoint(deviceId?)`, `getPointCount()`. (Waypoints/flagged are GONE: no `flagged`/`uid` columns — dropped by a guarded migration in `initDb`.)

## Routes (every new route needs `bruno/*.bru`)

- `GET|POST /health` — heartbeat: `upsertDevice` from `DeviceId`/`Username`/`Firmware-Version` headers (POST also body incl. `fw`), returns `{status, storedPoints, deviceId, heartbeat, serverTime}`. GET also piggybacks `session` (assigned scheduled/live session: id/mode/status/startTime/courseVersion/windDir/windSpeed/marks/startLine/finishLine/signals; null when unassigned) and `wind` `{dir,speed}` — venue wind from the boat's last stored point via the `store/wind.js` chain, stale-while-revalidate per device (10-min TTL / >2 km drift / first poll; session wind wins on the device).
- `gps.js`: `POST /gps` (validate lat/lon numbers, store + upsert device; `simulated` uploads ALWAYS feed the ephemeral single-point overlay AND **also persist to `gps_points` while the boat is racing** (todo 9), tagged `simulated: 1` so map styling and stats can tell them apart — so a finished mock session DOES have a Turso track, it is just simulated; `racingPersist(deviceId)` gates the persistence with a short cache), `GET /gps/sim-live?deviceId=` (latest sim point only, no history — refresh picks up upcoming fixes exclusively), `GET /gps?date=&deviceId=` or `?start=&end=`, `GET /gps/latest?deviceId=`, `GET /gps/count`, `GET /gps/days?deviceId=` (days with data + counts for per-boat calendar). Also keeps `devices.mock` in sync from the `simulated` field — transition-only writes, so the mock flag is reliable without a device change. No flagged/waypoint routes (removed 2026-10-09).
- `courses.js`: `GET /courses` (the whole library — five seeded built-ins first via `builtinKey`, then user courses alphabetically), `POST /courses` (`{name,desc?,owner?,marks[,startLine,finishLine]}`), `GET/PUT/DELETE /courses/:id` (PUT bumps `version`; **403 on a built-in** — they are read-only, copy-only). The five built-in shapes live in the same table, seeded once from `store/courseStore.js` (`seedBuiltinCourses`, idempotent). Optional line segments `{ax,ay,bx,by,square?,bias?}` (≥5m, square-to-wind default); `finishLine` may be `{sameAs:"start"}`. Geometry convention: **+y = upwind**, the start/finish line sits at `y=0` (leeward edge) and the course runs upwind from it.
- `sessions.js`: sessions encapsulate courses (frozen snapshot, never linked). Status is inferred on read (abandoned sticks; finished when every boat uploaded a run — boats only, so a
  boat-less session can never finish; live once the gun passes, boats or not; else scheduled) — `PUT` accepts only `abandoned` (or `scheduled` to re-open). **One active session per boat:** `addBoat`/`repeatSession` reject (409, message names the blocking session) when the boat is already in another scheduled/live session. **Auto-sim:** adding a boat that is currently `mock` auto-creates its scripted run (`store/sim.createRun`). `windSpeed` (kn, optional) is stored and pushed via health. `GET /sessions[?date=]`, `POST /sessions` (`{courseId}` or `{snapshot:{marks,startLine?,finishLine?}}` + placement → resolved marks; stamps `courseShapeVersion`; **`boats:[{deviceId,startOffsetSec?}]` may ride along in the same call** — same 409 guard + auto-sim, one round trip), `GET/PUT/DELETE /sessions/:id` (geometry edits re-resolve + bump the session's own `courseVersion`), `POST /sessions/:id/repeat` (same frozen shape onto a new day, boats carried over), `POST/DELETE /sessions/:id/boats[/:deviceId]` (participants + pursuit `startOffsetSec`). Run uploads: `POST /sessions/:id/runs` (device finish log `{deviceId,startEpoch,finishEpoch?,splits?,events?,result?}`, re-upload replaces), `GET /sessions/:id/runs` (results, finished first). Committee: `POST /sessions/:id/signals` (`{kind: OCS|DSQ|DNF|RET|SCP|RECALL|ABANDON, deviceId?, detail?}`), `GET /sessions/:id/signals` (log, oldest first).
- `wind.js`: `GET /wind?lat=&lon=[&provider=auto|wu|wc|om]` — suggest-only venue wind (WU PWS `WU_API_KEY` → Weathercloud unofficial → Open-Meteo model), 10-min cache keyed by `lat,lon,provider`; `provider` forces a single source (502 `no data from provider 'x'` when it has none, 400 on an unknown name); caller freezes value into session.
- `sim.js` (in-memory test rig, lost on restart): `POST /sim/runs {sessionId, deviceId?, speedKn?, startInSec?, roundingM?}` compiles a 1Hz scripted route (hold 300m behind the line → gun cross ~8s after the gun → fixed-radius roundings (default 15m, per-call override) holding each mark's required side, gate pairs threaded near the first buoy, legs as direct rhumbs + light noise → finish, seeded noise; default **28 kn**, clamped 1-40), `GET /sim/next?deviceId=` wall-clock delivery, `GET /sim/runs[?sessionId=]`, `DELETE /sim/runs/:id`, **`GET /sim/routes/:sessionId`** (the route keyed by SESSION, served from `store/simRoute.js` — session-keyed because the frontend only holds a session id, and a run is pruned 10 min after it ends, so a run-id lookup 404s exactly when a finished race is being inspected), `GET /sim/wander?deviceId=` server-driven wander fix (**viewport anchor when pushed → else this boat's own newest stored point → else the newest point in the DB**; 404 only when the DB has nothing at all). The DB fallbacks seed the walk **once**, on the first poll for a boat — the 1Hz poll never queries the DB. After seeding, with no browser anchor, the walk is free; `seededFrom` in the response says which rung was used, `POST /sim/anchor {lat,lon}` sets the viewport anchor. **The script overruns the finish line by 200m along the incoming bearing** — the route's last waypoint is the line's centre, so stopping there left the side flip that scores a finish on a single sample (the last of the run) and every mock race ended on the device's "past line, no clean cross" escape hatch.
- `devices.js` (+ `/boats` alias): `GET /devices`, `GET /boats`, `PUT /devices/:id` / `PUT /boats/:id` rename `{username, boat}` (no heartbeat side effects), `POST /devices/:id/mock` / `POST /boats/:id/mock` `{on:bool}` (proxies to the device portal `/mock` over LAN via stored `ip`, then records `mock`; 409 no known ip, 502 portal unreachable), `DELETE /devices/:id` (+ `/boats/:id`).

## Frontend (`public/`)

- `index.html` + `style.css` + ordered classic scripts (was single `app.js`, split 2026-10-15 —
  keep this order, names resolve at call time): `core.js` (map) → `chrome.js` (panel drag/cascade —
  pure definitions, early because pane toggles call it at load) → `boats.js` (fleet list/panels) →
  `live.js` (live-sim overlay) → `prefs.js` (saved prefs) → `mode.js` (UI store + Bus + transitions) →
  `fleet.js` (stored tracks) → `timeline.js` (playback + unified `refresh()`) → `panes.js` (topbar panes) →
  `race.js` (courses/builder/sessions) → `boot.js` (startup calls only).
  Leaflet 1.9.4 CDN. Topbar: Boats/Wind/Timeline/Sessions/Course/New session/Settings toggles, Live button + preset (today/yesterday/thisWeek/custom) + datetime pickers + recenter.
- Pane chrome is uniform: every floating pane (boats, wind, course, sessions, session detail, new session, edit course, settings, per-boat) uses the same light-gray `#e5e7eb` header bar with one large `.pane-close` × (`h4` rule near `#device-panel h4`; boat pane icons use `.pane-btn` + `.pane-actions`, and must stay `<span>` — `makePanelDraggable` excludes header drags via `h4 span`). Panel drag excludes header buttons; the boat-pane icons are the exception by design.
- Settings pane: `windProvider` (`auto|wu|wc|om`, sent to `/wind`) + `windRefreshMin` (5/10/20/30/0=off) — the single source of truth for wind auto-refresh; the wind pane ↻ is a one-off refresh only (the old AUTO toggle is gone). Both prefs live in the UI prefs blob, so they must be declared before `loadUI()` runs.
- Map: polyline tracks, per-boat colored stripes, no-auto-pan (recenter on demand), hover 100m dots, click-to-jump. Clicking a boat (marker, track, or the **live-sim arrow**) opens its panel: mock boats never reach Turso (`simulated` uploads go to the ephemeral slot), so `findNearestPoint`/`currentPointForBoat` also consider `liveSimLatest(id)` — Turso's newest fix for a mock boat can be days old and km away.
- Boat panels (Leaflet controls, draggable): Speed/Course/Time + Boat make-model, header icons ⌖ (center map, keeps zoom) + ⓘ (info modal) + ×. Info modal: read-only Device/Status/Firmware/Last/First seen + editable Boat name + Make/model → `PUT /boats/:id`, list + panels refresh.
- Boats list: filter, status dots + firmware (`v1.0.x` after lastSeen when reported), 📅 per-row sailing-days calendar (active days in boat color → click sets custom day range).
- Races menu (topbar dropdown): Courses panel (5 built-in courses + yours + blank → builder) and Sessions panel (create + committee: start +5:00/postpone/custom start, status, boats + pursuit offsets, repeat onto new day, delete). Panels draggable, positions persisted, auto-cascade on overlap. The **session-detail** pane only ever shows a selected session: `selectedSessionId` is NOT persisted, so `loadSessions()` drops it when the session vanished (deleted via API) and hides a restored-but-empty pane at boot — otherwise a ghost id re-opens a blank pane forever.
- Builder (right panel, map stays visible): courses only. Click-to-drop + draggable marks (type/radius/order, side on roundings only), whole-course Move drag, bottom-left wind dial + `/wind` suggest, scale, lines list (define/drag ends/move, same-as, bias/square), gate auto-pairing + pile badges, live dashed route + naked meter labels (toggle). Drafts in `localStorage`.
- Playback: play/rewind/speed 1–20x, timeline with per-boat tracks + speed overlay, cursor follows nearest real point, live hides timeline.
- `public/ota/latest.txt + firmware.bin` — written by device `make dist`, served static. `favicon.svg` boat icon.

## Bruno / verify / deploy

- `tools/` (dev helpers, not routes — no `.bru` needed):
  - `new-mock-session.js [distM] [gunSec] [courseId] [windDir]` — creates a scripted session laid out the way the **device** does: the line `distM` metres UPWIND of the boat, never on top of it. The boat then waits outside the 150m OCS band instead of on the line, where a metre of jitter read as a crossing. Reads position from `/gps/sim-live` **first** — a mock boat never reaches Turso, so `/gps/latest` is the last REAL fix, days old and km away.
  - `check-route.js [sessionId]` — recompiles a real session and checks it against the rules the **device** scores by: every mark circle entered, either buoy of every gate, and a finish crossing that is *sustained* inside the band (≥3 samples of the new side). Exits non-zero, so it can gate a change to `compileScript`. The "sustained" part is what catches a flip that exists only on the final sample — the real bug.
  - `check-ocs.js [sessionId]` — replays the approach through the device's OCS predicate (transcribed from `race_run.cpp`) twice: as sailed (must stay silent) and shifted so the boat crosses 20s early (must raise OCS). A quiet OCS detector is a worse bug than a noisy one, and a green mock race cannot tell them apart. Move the **samples**, not the gun — moving the gun closes the pre-gun window before the boat reaches the line and reports a failure that is an artefact of the test.
  - `race.sh [distM] [gunSec] [courseId] [windDir]` — one race end to end. Verifies the device is on the race screen via `sys.page` before creating anything, snapshots the 200-line serial ring to a file every 4s, and stamps `LINK LOST` if the portal or backend goes away — a **laptop suspend kills the local backend and the race with it**, and an unmarked partial race is indistinguishable from a firmware bug.

- `bruno/` mirrors routes: `health/ gps/ devices/` (incl. `devices-rename.bru`, `devices-mock.bru`), `courses/`, `sessions/` (incl. snapshot + repeat + `add-boat-conflict.bru`), `sim/` (incl. `wander.bru`), `wind/` + `environments/local.bru (:3000)` + `production.bru (onrender)`. Rule: new endpoint → new `.bru`, test both envs.
- Local check (`sl`): `node server.js` → `curl localhost:3000/health /devices /boats /courses /gps?date=YYYY-MM-DD`; removed routes return 404 (`/templates/*`, `/races`).
- Deploy (`sc`): commit + push `main`, then `POST $REDPLOY_HOOK_URL` (push alone does NOT redeploy), verify `/devices`. OTA publish comes from the device repo `make dist` (= `dc`), which commits firmware into `public/ota/` here — note it re-fires the same hook, so `sc` then `dc` double-deploys and `dc` alone covers both.
- Working mode (`devl` / `devc`, defined in the root `AGENTS.md`): `devl` = this backend
  runs at `:3000` and the device points at it (`POST /server?mode=dev&host=<ip>:3000`);
  `devc` = Render serves the code. Either way the DB is the same live Turso.
- No auth anywhere — identity is `DeviceId` MAC header. Keep validation + username whitelist in sync with firmware.
- **Destructive schema changes: never drop a column while the OLD build is still live.**
  2026-10-09: dropping `gps_points.flagged` locally killed prod (`SQL_INPUT_ERROR: no such
  column: flagged` at `store/db.js:94`) because the deployed build still selected it — every
  DB-backed route 500'd until `sc` redeployed the new code. Safe order: (1) deploy code that
  stops using the column, (2) drop it in a later deploy (or keep it one release). Local
  `:3000` shares the LIVE Turso DB, so a local migration IS a prod migration.
- **A RENAME cuts both ways: the old build renames the table BACK on every cold start.**
  2026-10-10: renaming `templates`→`courses` locally worked, then Render spun the instance
  down; the wake-up ran the deployed build's `ALTER TABLE courses RENAME TO templates` +
  `sessions.templateId`, silently reverting the migration. Prod stayed healthy (old code +
  old names = self-consistent) while **local `:3000` broke** with `no such table: courses`.
  Lesson: a hard rename has a hard deploy dependency — the backend must ship in the same
  round as the schema. Until then local DB work is a treadmill (each prod cold start undoes
  it), so verify with `SELECT name FROM sqlite_master` + a `PRAGMA table_info`, not with
  `/health` (health doesn't read the renamed tables and looks fine).
- **A stray `DeviceId` header rewrites a device's recorded LAN `ip`.**
  `upsertDevice` takes `ip` from `req.ip` on every `/health` and `/gps`, and
  identity is the unauthenticated `DeviceId` header by design. So
  `curl localhost:3000/health -H "DeviceId: 08:…"` — the obvious way to poke
  the endpoint by hand — makes the backend record `127.0.0.1` as that boat's
  address, because the request came from loopback (`cleanIp` maps `::1` →
  `127.0.0.1`). The next real heartbeat fixes it, but until then
  `POST /devices/:id/mock` proxies the portal request to loopback and fails,
  and it looks like the device moved. **Read `/devices` before using the `ip`
  for anything, and never "verify" `/health` with a spoofed DeviceId.**

- **`ALTER TABLE ... RENAME COLUMN` breaks on a table grown by many `ADD COLUMN`s.**
  SQLite re-parses the accumulated schema and fails with `duplicate column name:
  courseShapeVersion`. `initDb` now **rebuilds** `sessions` into its canonical shape
  (rename → `sessions_legacy`, copy with per-column source aliases, drop) whenever a
  legacy `template*` column is still present. Prefer a rebuild over a rename for tables
  that have been migrated repeatedly.
- **`ABANDON` is session-scoped, so raising it stores `status='abandoned'`.**
  Status is otherwise inferred on read, so without that an abandoned session kept being
  inferred scheduled/live: it stayed on the health piggyback (a device that walked away was
  handed the session straight back) and kept the boat blocked from starting a new one.
- **Never rewrite `public/*.js|css|html` with PowerShell `Set-Content`/`Out-File`** — they
  default to a legacy codepage and silently double-encode every non-ASCII char (UTF-8 → CP1252
  → UTF-8), so `·` becomes `Â·`, `→` becomes `â†’`, `×` becomes `Ã—`. The file stays *valid*
  UTF-8, so a validity check passes and the browser faithfully renders the garbage — it looks
  like corruption in the wind pane, top bar, boats and courses all at once (hit 2026-10-09:
  131 sequences in `app.js`, repaired in `fb75ce4`). Use the edit tool; if a shell write is
  unavoidable go through Node (`fs.readFileSync/writeFileSync(..., "utf8")`).
  Repair/verify recipes (Node, not PowerShell — the console mangles the literals):
  decode the mojibake run through **windows-1252 → bytes → UTF-8**, and accept a result only
  if it is valid UTF-8 with no control chars. A plain latin1 pass has no such guard and turns
  correct `—`/`…`/`•` into `\u0014`/`&`/`"`. Degree signs in rendered HTML: prefer the ASCII
  entity `&deg;`.
