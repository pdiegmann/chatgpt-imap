
# syntax=docker/dockerfile:1

# Use oven/bun as the base image for build efficiency
FROM oven/bun:1.1.13-alpine AS base

WORKDIR /app


# Install dependencies only when needed
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Build the project (if using TypeScript)
RUN bun run build

# Production image, copy only necessary files
FROM oven/bun:1.1.13-alpine AS prod
WORKDIR /app

# Install only production dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy compiled output from the build stage
COPY --from=base /app/dist ./dist

# Set environment variables
ENV NODE_ENV=production

# Create data directory for persistent OAuth client registrations
RUN mkdir -p /app/data

# Expose data directory as a volume so OAuth clients survive container restarts
VOLUME ["/app/data"]

# Default command (adjust as needed)
CMD ["bun", "dist/server/mcp.js"]
