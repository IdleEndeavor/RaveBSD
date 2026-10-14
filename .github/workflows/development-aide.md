# .github/workflows/ : automation

| File | What it does |
| --- | --- |
| `publish.yml` | On every push to `main` and on version tags (`v*`): installs with `npm ci --ignore-scripts`, runs `npm test`, then builds the Docker image for `linux/amd64` and `linux/arm64` and pushes it to GitHub Container Registry (`ghcr.io/<owner>/<repo>`). `main` is tagged `latest`, version tags get their semver tag, and every build gets a `sha` tag. The commit is passed in as `BUILD_ID`, which the admin panel shows under System next to the version. |

People who run RaveBSD update with `docker compose pull` (or `./update.sh`), so whatever lands on `main` reaches them. A failing `npm test` stops the image from being published.

`publish.yml` asks only for the `permissions` it needs: `contents: read` and `packages: write`.
