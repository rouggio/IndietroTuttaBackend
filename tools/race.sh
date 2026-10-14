#!/usr/bin/env bash
# Run one full mock race on the device and report the result.
#
# Two things this exists to stop repeating:
#  1. Navigating the device with /btn without checking where it landed. The
#     mock feed sails the boat whatever page is showing, so a device parked on
#     MAIN produces a race with no countdown, no marks and no finish, and
#     nothing in the old /status said why. /status now reports sys.page.
#  2. The 200-line serial ring scrolling past the interesting part. The whole
#     buffer is snapshotted to a file every few seconds and de-duplicated
#     afterwards.
#
# Usage: race.sh [distM] [gunSec] [courseId] [windDir]
set -u
DIST=${1:-30}; GUN=${2:-80}; COURSE=${3:-34}; WIND=${4:-45}
DEV=http://192.168.0.106
BE=http://localhost:3000
LOG=/tmp/race_$(date -u +%H%M%S).log

page_now() { curl -s --max-time 8 $DEV/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).sys.page||"?")}catch(e){console.log("?")}})'; }

echo "device page: $(page_now)"
for i in 1 2 3 4; do
  p=$(page_now)
  [ "$p" = "race" ] && break
  echo "  navigating (on '$p')"
  curl -s --max-time 8 -X POST "$DEV/btn?b=L&e=R" >/dev/null
  sleep 3
done
p=$(page_now)
if [ "$p" != "race" ]; then echo "FAILED: could not reach the race screen (page='$p')"; exit 1; fi
echo "device page: $p  (verified)"

for s in $(curl -s --max-time 15 $BE/sessions | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{JSON.parse(d).forEach(x=>console.log(x.id));});'); do
  curl -s --max-time 10 -X DELETE $BE/sessions/$s >/dev/null && echo "deleted stale session $s"
done

cd "$(dirname "$0")/.." || exit 1
node tools/new-mock-session.js "$DIST" "$GUN" "$COURSE" "$WIND" || exit 1

# Snapshot the whole ring buffer every 4s for 8 minutes.
( for i in $(seq 1 120); do curl -s --max-time 6 $DEV/serial >> $LOG 2>/dev/null; echo "" >> $LOG; sleep 4; done ) &
CAP=$!
echo "capturing to $LOG"
wait $CAP
echo "=== race result ==="
grep -oE "^\[[0-9/: ]+Z\] \[(RACE|SOUND)\].*" $LOG | sort -u | sort | grep -E "session updated|gun 1:00|started|passed|armed|finished|OCS|RECROSS|last mark"