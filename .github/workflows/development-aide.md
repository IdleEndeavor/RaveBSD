# .github/workflows/ : automation

| File | What it does |
| --- | --- |
| `publish.yml` | On every push to `main` and on version tags (`v*`): installs with `npm ci --ignore-scripts`, runs `npm test`, then builds the Docker image for `linux/amd64` and `linux/arm64` and pushes it to GitHub Container Registry (`ghcr.io/<owner>/<repo>`). `main` is tagged `latest`, version tags get their semver tag, and every build gets a `sha` tag. The commit is passed in as `BUILD_ID`, which the admin panel shows under System next to the version. |

Every action is pinned to a commit SHA, with its version in a comment, so a moved tag cannot change what runs; moving a pin forward is done by hand. The Docker base image is not pinned, so release builds pick up Node and Debian security fixes. The published image carries an SBOM and a provenance record (`sbom: true`, `provenance: mode=max`), which `docker buildx imagetools inspect ghcr.io/<owner>/<repo> --format '{{json .SBOM}}'` (or `.Provenance`) prints.

People who run RaveBSD update with `docker compose pull` (or `./update.sh`), so whatever lands on `main` reaches them. A failing `npm test` stops the image from being published.

`publish.yml` asks only for the `permissions` it needs: `contents: read` and `packages: write`.
