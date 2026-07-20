# Infra: Docker

Applies when: writing or modifying a `Dockerfile`, `docker-compose.yml`, or build script.

Do:

- Use a multi-stage build: a `builder` stage compiles, a slim `runtime` stage runs. Copy only what the runtime needs.
- Pin base images by digest (`FROM python:3.11-slim@sha256:...`) or at minimum a specific version tag. Never `latest`.
- Maintain a `.dockerignore` so `node_modules/`, `.git/`, secrets, and build artifacts never enter the build context.
- Run as a non-root user in the runtime stage (`USER appuser`).
- Layer order = least-changing to most-changing. Dependencies before source.

Do not:

- Do not bake secrets into images. Use `--secret` mounts (BuildKit) or runtime env.
- Do not use `latest` tags for base images. Reproducibility evaporates.
- Do not run as root in the runtime stage.
- Do not `apt-get update` without `apt-get install -y --no-install-recommends` and `rm -rf /var/lib/apt/lists/*` in the same RUN.

Commands:

```bash
# Build
docker build -t app:dev .

# Inspect image layers
docker history app:dev

# Confirm .dockerignore is working
docker build --progress=plain -t app:dev . 2>&1 | grep 'transferring context'
```
