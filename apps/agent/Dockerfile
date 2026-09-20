# syntax=docker/dockerfile:1
# The agent runtime (docs/AGENT-RUNTIME.md). Same shape as apps/server's image,
# and deliberately so — the traps are identical and documented there.
FROM node:24-slim

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Manifests first, and EVERY workspace member's: `--frozen-lockfile` validates
# the lockfile against the whole workspace, so a missing one fails the install.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/server/package.json       apps/server/
COPY apps/agent/package.json        apps/agent/
COPY apps/desktop/package.json      apps/desktop/
COPY packages/authz/package.json    packages/authz/
COPY packages/genui/package.json    packages/genui/
COPY packages/icons/package.json    packages/icons/
COPY packages/protocol/package.json packages/protocol/
COPY packages/telemetry/package.json packages/telemetry/

# `--filter "@relayed/agent..."` takes the agent and its workspace dependencies
# and nothing else. `--ignore-scripts` alongside `--prod` because the root
# `prepare` runs husky, which `--prod` has just declined to install.
#
# PLAIN `pnpm install`, NEVER `pnpm deploy` — Node refuses to strip types from a
# TypeScript file physically under node_modules, and pnpm's symlink layout is
# what keeps the realpath outside it (docs/DEPLOY.md §4a).
RUN pnpm install --prod --ignore-scripts --frozen-lockfile --filter "@relayed/agent..."

COPY packages/ packages/
COPY apps/agent/ apps/agent/

USER node

EXPOSE 8788

# Exec form so node is PID 1 and gets SIGTERM unwrapped.
WORKDIR /app/apps/agent
CMD ["node", "src/index.ts"]
