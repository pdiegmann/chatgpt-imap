
# syntax=docker/dockerfile:1

# Use oven/bun as the base image for build efficiency
FROM oven/bun:1.1.13-alpine AS base

WORKDIR /app

# Install dependencies only when needed
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Build the project (if using TypeScript)
RUN bun run build || true

# Production image, copy only necessary files
FROM oven/bun:1.1.13-alpine AS prod
WORKDIR /app

# Copy node_modules and built files from base
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/src ./src
COPY --from=base /app/tsconfig.json ./
COPY package.json ./

# Set environment variables
ENV NODE_ENV=production

# Default command (adjust as needed)
CMD ["bun", "run", "start"]
