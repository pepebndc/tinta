#!/usr/bin/env bash
# Deploys the website on the server (178.105.63.159). Idempotent.
#
# GitHub Actions runs it on every push to main that changes website/ or deploy/
# (see .github/workflows/deploy-website.yml). The deploy key of the workflow can
# only run this script: its line in /root/.ssh/authorized_keys has a forced command.
# By hand: ssh hetzner /opt/tinta/deploy/deploy.sh
#
# Safety: this script does not touch /opt/tavola or /opt/emulsioncamp, and it never
# restarts the shared proxy. It only writes /opt/edge/sites/tinta.caddy, checks it
# with `caddy validate` before the reload, and restores the old file on an error.
set -euo pipefail

REPO=https://github.com/pepebndc/tinta.git   # public repo: no deploy key needed
BRANCH=main
APP=/opt/tinta
EDGE=/opt/edge
SITE="$EDGE/sites/tinta.caddy"

exec 9>/var/lock/tinta-deploy.lock
flock 9   # one deploy at a time

# Step 1: update the checkout, then run the new version of this script.
if [ "${1:-}" != "--after-pull" ]; then
  if [ ! -d "$APP/.git" ]; then
    git clone --branch "$BRANCH" "$REPO" "$APP"
  fi
  git config --global --add safe.directory "$APP" 2>/dev/null || true
  git -C "$APP" fetch --quiet origin "$BRANCH"
  git -C "$APP" reset --quiet --hard "origin/$BRANCH"
  echo "checkout at $(git -C "$APP" log -1 --format='%h %s')"
  flock -u 9
  exec "$APP/deploy/deploy.sh" --after-pull </dev/null
fi

# Step 2: the Caddy site, only when it changes, with a check and a rollback.
docker network inspect edge >/dev/null 2>&1 || { echo "the docker network 'edge' is missing"; exit 1; }
if ! cmp -s "$APP/deploy/tinta.caddy" "$SITE"; then
  BAK=""
  if [ -f "$SITE" ]; then BAK="$(mktemp)"; cp "$SITE" "$BAK"; fi
  restore() {
    if [ -n "$BAK" ]; then cp "$BAK" "$SITE"; else rm -f "$SITE"; fi
    echo "invalid Caddy config: restored the old file, the proxy is unchanged"; exit 1
  }
  caddy_exec() { (cd "$EDGE" && docker compose exec -T caddy caddy "$@" --config /etc/caddy/Caddyfile); }
  cp "$APP/deploy/tinta.caddy" "$SITE"
  caddy_exec validate || restore
  caddy_exec reload   || restore
  if [ -n "$BAK" ]; then rm -f "$BAK"; fi
  echo "Caddy site updated and reloaded"
fi

# Step 3: nginx. The files are directory mounts, so a reload is enough for config changes.
cd "$APP/deploy"
docker compose up -d
docker compose exec -T web nginx -t
docker compose exec -T web nginx -s reload
docker compose ps
echo "deployed"
