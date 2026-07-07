# Runtime image for the Spacehatch backend.
# The gh CLI is a hard runtime dependency: it provides the tunnel transport
# (see backend/src/ssh/ghTransport.ts). GitHub itself cannot host this
# process — deploy the image to any container host (Fly.io, Cloud Run, a VM).

FROM node:22-slim AS build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# Install the GitHub CLI from the official apt repository
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh openssh-client \
  && rm -rf /var/lib/apt/lists/*

# Non-root user; gh writes its generated SSH key below $HOME/.ssh
RUN useradd --create-home appuser
USER appuser
WORKDIR /app

COPY --chown=appuser backend/package.json backend/
COPY --from=build --chown=appuser /app/backend/node_modules backend/node_modules
COPY --from=build --chown=appuser /app/backend/dist backend/dist
COPY --chown=appuser frontend frontend

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "backend/dist/server.js"]
