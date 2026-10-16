#!/usr/bin/env bash
# Sail one mock race per course on the device and report each result.
# Repeatable by course: race-matrix.sh [distM] [gunSec] [ids]
# Defaults: 30m, 80s, all built-ins 34,35,36,37,38.
# Test-ops rules: capture is bounded to gun+run+30s AND stops early on the
# terminal state (finish / unassigned / abandon) — never idles to the cap.
set -u
DIST=${1:-30}; GUN=${2:-80}; IDS=${3:-34,35,36,37,38}
DEV=${DEV:-http://192.168.1.13}
BE=${BE:-http://localhost:3000}

page_now() { curl -s --max-time 8 $DEV/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).sys.page||"?")}catch(e){console.log("?")}})'; }

p=$(page_now)
if [ "$p" != "race" ]; then echo "park the device on the race screen first (now '$p')"; exit 1; fi

IFS=',' read -ra COURSES <<< "$IDS"
overall=0
for COURSE in "${COURSES[@]}"; do
  echo "=== course $COURSE ==="
  for s in $(curl -s --max-time 15 $BE/sessions | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{JSON.parse(d).forEach(x=>console.log(x.id));});'); do
    curl -s --max-time 10 -X DELETE $BE/sessions/$s >/dev/null
  done
  info=$(node tools/new-mock-session.js "$DIST" "$GUN" "$COURSE" 0) || { echo "FAILED: session create"; overall=1; continue; }
  echo "$info"
  sid=$(echo "$info" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const m=d.match(/session (\d+)/);console.log(m?m[1]:"")})')
  dur=$(echo "$info" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const m=d.match(/ (\d+)s$/m);console.log(m?m[1]:"240")})')
  cap=$(( (GUN + dur + 30) / 4 ))
  end=0
  for ((i = 1; i <= cap; i++)); do
    snap=$(curl -s --max-time 6 $DEV/serial)
    echo "$snap" | grep -oE '\[RACE\] (started|passed|wrong side|finished|OCS|RECROSS|ABANDON).*' | sort -u
    if echo "$snap" | grep -qE 'finished \(line|FINISH.*line|session unassigned|ABANDON'; then end=1; break; fi
    sleep 4
  done
  echo "--- upload ---"
  curl -s --max-time 10 "$BE/sessions/$sid/runs"
  echo ""
  curl -s --max-time 10 -X DELETE $BE/sessions/$sid >/dev/null && echo "(session $sid cleaned)"
  [ "$end" = "1" ] || { echo "course $COURSE: no terminal state in bounds"; overall=1; }
done
exit $overall
