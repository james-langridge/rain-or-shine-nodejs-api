# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install ALL dependencies (including dev)
RUN npm ci

# Copy migrations
COPY migrations ./migrations/

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Copy docs directory to dist (for OpenAPI spec)
RUN cp -r src/docs dist/

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy migrations
COPY migrations ./migrations/

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy any other necessary files (if needed)
# COPY .env.example .env.example

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership
RUN chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3001

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Run migrations and start the app
CMD ["sh", "-c", "npm run migrate && npm start"]
