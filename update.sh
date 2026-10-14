#!/bin/sh
# Updates RaveBSD to the latest published version. Your settings, shelf and books are not touched.
# Run it by hand, or from cron, for example every night at 4:
#   0 4 * * * cd /path/to/RaveBSD && ./update.sh
set -e
cd "$(dirname "$0")"
# compose.yaml and the files next to it change between versions too (2.0 added folders and a browser profile).
if [ -d .git ]; then
    git pull --ff-only || echo "Could not update compose.yaml and the other files (local changes?). Updating the image only."
fi
docker compose pull
docker compose up -d
docker image prune -f > /dev/null
echo "RaveBSD is up to date."
