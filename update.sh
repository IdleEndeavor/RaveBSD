#!/bin/sh
# Updates RaveBSD to the latest published version. Your settings and stats in ./data are not touched.
# Run it by hand, or from cron, for example every night at 4:
#   0 4 * * * cd /path/to/RaveBSD && ./update.sh
set -e
cd "$(dirname "$0")"
docker compose pull
docker compose up -d
docker image prune -f > /dev/null
echo "RaveBSD is up to date."
