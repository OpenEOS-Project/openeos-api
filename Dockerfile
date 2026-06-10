# syntax=docker/dockerfile:1

# ============================================
# Stage 1: Dependencies
# ============================================
FROM node:20-alpine AS deps

RUN corepack enable && corepack prepare pnpm@10.16.0 --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# ============================================
# Stage 2: Builder
# ============================================
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.16.0 --activate

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the application
RUN pnpm build

# ============================================
# Stage 3: Production dependencies
# ============================================
FROM node:20-alpine AS prod-deps

RUN corepack enable && corepack prepare pnpm@10.16.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

# Install only production dependencies
RUN pnpm install --frozen-lockfile --prod

# ============================================
# Stage 4: Runner (Production)
# ============================================
FROM node:20-alpine AS runner

# Install dumb-init for proper signal handling + tzdata so we can pin TZ
RUN apk add --no-cache dumb-init tzdata

# Default container timezone — all toLocaleString / Date.now formatting on
# the server will read 'Europe/Berlin' unless an env override is supplied.
ENV TZ=Europe/Berlin

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nestjs

WORKDIR /app

# Copy production dependencies
COPY --from=prod-deps --chown=nestjs:nodejs /app/node_modules ./node_modules

# Copy built application
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./
# Static assets (e.g. brand logo embedded into generated PDFs)
COPY --from=builder --chown=nestjs:nodejs /app/assets ./assets

# Create uploads directory
RUN mkdir -p /app/uploads && chown nestjs:nodejs /app/uploads

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Build version injected by CI (GitHub run number), exposed via /api/health
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

# Switch to non-root user
USER nestjs

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/main.js"]
