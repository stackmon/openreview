# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app

RUN --mount=type=bind,source=package-lock.json,target=package-lock.json \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=cache,target=/root/.npm \
    npm ci

COPY . .
RUN npm run build

# git is a runtime dependency: the only subprocess the service starts is
# `git clone` of the pull request branch it reviews.
FROM node:20-alpine AS final

RUN apk --no-cache add git ca-certificates

# Matches the runAsUser the deployment pins; the node image's own user is 1000.
RUN addgroup -g 1001 appuser && adduser -D -u 1001 -G appuser appuser

WORKDIR /app

# .agents/skills is resolved against process.cwd() at runtime.
COPY --from=build /app/dist ./dist
COPY --from=build /app/.agents ./.agents

USER appuser

ENV HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=8090

EXPOSE 8090

CMD ["node", "dist/server.js"]
