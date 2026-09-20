# The server image. Built by Railway, but deliberately plain: nothing in here is
# Railway-specific, so the same image runs on a VPS, Fly or anything else
# (docs/DEPLOY.md, "Moving out").
#
# NO BUILD STEP, and that is not an omission. `apps/server` and every workspace
# package it imports export raw `.ts`, and Node strips the types at load. There
# is nothing to compile, so there is no build stage and no `dist/`.

# Pinned to .nvmrc, which CI also reads. Debian rather than Alpine: nothing here
# is size-sensitive, and musl is a category of surprise we gain nothing from.
FROM node:24-slim

# pnpm via corepack, which takes its version from `packageManager` in the root
# package.json — one source of truth rather than a number to keep in sync here.
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# ── Manifests first, so a source edit does not re-resolve the whole workspace ──
#
# EVERY workspace member's package.json, not just the server's. pnpm-workspace.yaml
# globs `apps/*` and `packages/*`, and `--frozen-lockfile` validates the lockfile
# against the full set — a missing manifest fails the install rather than being
# skipped.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/server/package.json       apps/server/
COPY apps/agent/package.json        apps/agent/
COPY apps/desktop/package.json      apps/desktop/
COPY packages/authz/package.json    packages/authz/
COPY packages/genui/package.json    packages/genui/
COPY packages/icons/package.json    packages/icons/
COPY packages/protocol/package.json packages/protocol/
COPY packages/telemetry/package.json packages/telemetry/

# `--filter "@relayed/server..."` installs the server AND its workspace
# dependencies, and nothing else. Without it the image would pull Electron —
# a devDependency of @relayed/desktop, and over 100MB the server never loads.
#
# `--prod` drops devDependencies, which for this subtree is typescript, eslint,
# prettier and the type packages — none of which a running server loads. Node
# strips types without typechecking, so nothing here needs a compiler.
#
# `--ignore-scripts` because the root `prepare` runs husky, which `--prod` has
# just declined to install, and a git hook manager has no purpose in an image
# with no .git. It also means no dependency postinstall executes during a
# production build — the same stance pnpm-workspace.yaml already takes by
# allowlisting build scripts by name.
#
# PLAIN `pnpm install`, NEVER `pnpm deploy`. Node refuses to strip types from a
# TypeScript file that physically lives under node_modules
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, verified). pnpm's default layout
# SYMLINKS each workspace package, so the realpath resolves to /app/packages/…
# and stripping applies. `pnpm deploy` — and `node-linker=hoisted` — copy real
# files into node_modules instead, and the server dies on its first import with
# an error that names none of this.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --ignore-scripts --frozen-lockfile --filter "@relayed/server..."

# ── Source ──
# Only what the server loads. The renderer, the spikes and the tooling are not
# part of this image.
COPY packages/ packages/
COPY apps/server/ apps/server/

# Drop privileges. The base image ships a `node` user; nothing here needs root.
USER node

# Cosmetic — Railway routes to $PORT, which env.ts already reads.
EXPOSE 8787

# Exec form, so node is PID 1 and receives SIGTERM directly. index.ts registers
# its own handler and needs the signal to arrive unwrapped: it closes sync
# sockets with a code before exiting, which is what lets clients reconnect
# immediately instead of discovering the restart at their next heartbeat.
WORKDIR /app/apps/server
CMD ["node", "src/index.ts"]
