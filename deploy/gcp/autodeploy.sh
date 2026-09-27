#!/bin/bash
# Self-deploy: run periodically by autodeploy.timer (systemd), not by CI.
# CI's only job (.github/workflows/publish.yml) is to build and push
# ghcr.io/pacestreak/api:latest - nothing in this org's GitHub Actions ever
# touches this VM. This script is what actually pulls and rolls out a new
# image, on the VM's own schedule, with no inbound SSH path for a deploy at
# all - see infra/DECISIONS.md.
set -euo pipefail

IMAGE_REPO="ghcr.io/pacestreak/api"
STACK="pacestreak"

log() { logger -t autodeploy "$*"; }

# Pulling :latest is idempotent and cheap once the layers are cached; this is
# how the check for "is there something new" is done, not a separate
# manifest-inspect call, so it works with whatever auth `docker login` left
# in this user's docker config with no extra credential handling here.
if ! docker pull -q "$IMAGE_REPO:latest" >/tmp/autodeploy-pull.log 2>&1; then
  log "pull failed: $(tail -1 /tmp/autodeploy-pull.log)"
  exit 1
fi

NEW_DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_REPO:latest")"
RUNNING_DIGEST="$(docker service inspect --format='{{.Spec.TaskTemplate.ContainerSpec.Image}}' "${STACK}_api")"

if [[ "$NEW_DIGEST" == "$RUNNING_DIGEST" ]]; then
  exit 0
fi

log "deploying $NEW_DIGEST (was $RUNNING_DIGEST)"

# --with-registry-auth ships this host's docker login to every swarm node so
# the (only) node can actually pull; --update-order start-first is the whole
# reason this runs on Swarm rather than plain Compose - the new task must
# pass its healthcheck before the old one stops, so cloudflared never sees a
# gap. Pinned to the resolved digest, not the mutable :latest tag - Swarm
# only re-checks an image reference when it changes, so re-deploying
# ":latest" verbatim would silently no-op on the next task restart.
docker service update --quiet --image "$NEW_DIGEST" --with-registry-auth --update-order start-first "${STACK}_api"
docker service update --quiet --image "$NEW_DIGEST" --with-registry-auth --update-order start-first "${STACK}_worker"

log "deployed $NEW_DIGEST"
