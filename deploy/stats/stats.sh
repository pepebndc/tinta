#!/usr/bin/env bash
# Builds the stats page from the nginx access log. The timer tinta-stats.timer runs it
# every 10 minutes, and logrotate runs it before each rotation.
#
# GoAccess keeps its data in $OUT/db (--persist, --restore), so the history outlives
# the raw logs. The raw logs stay 14 days. The data has no full IPs (--anonymize-ip).
set -euo pipefail

LOG=/var/log/tinta
OUT=/var/lib/tinta-stats
GEO="$OUT/geo/dbip-country-lite.mmdb"

exec 9>/var/lock/tinta-stats.lock
flock 9

mkdir -p "$OUT/db" "$OUT/html" "$OUT/geo"

# Countries: the free DB-IP database (CC BY 4.0), updated once a month.
if [ ! -s "$GEO" ] || [ -n "$(find "$GEO" -mtime +35)" ]; then
  url="https://download.db-ip.com/free/dbip-country-lite-$(date -u +%Y-%m).mmdb.gz"
  if curl -fsSL --max-time 60 "$url" | gunzip > "$GEO.tmp" && [ -s "$GEO.tmp" ]; then
    mv "$GEO.tmp" "$GEO"
  else
    rm -f "$GEO.tmp"; echo "could not update the GeoIP database, keeping the old one"
  fi
fi

files=()
for f in "$LOG/access.log.1" "$LOG/access.log"; do [ -s "$f" ] && files+=("$f"); done
[ ${#files[@]} -gt 0 ] || exit 0

geo=()
[ -s "$GEO" ] && geo=(--geoip-database "$GEO")

# GoAccess remembers the last line it read in each file, so a second pass adds nothing.
goaccess "${files[@]}" "${geo[@]}" \
  --log-format=COMBINED \
  --persist --restore --db-path "$OUT/db" --keep-last=730 \
  --anonymize-ip --ignore-crawlers \
  --html-report-title "usetinta.com" \
  --no-progress \
  -o "$OUT/html/index.tmp.html"
mv "$OUT/html/index.tmp.html" "$OUT/html/index.html"
