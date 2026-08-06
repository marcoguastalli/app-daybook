FROM oven/bun:1.3.9-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.9-alpine AS runtime
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/server ./src/server
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 7777
CMD ["bun", "src/server/index.ts"]
