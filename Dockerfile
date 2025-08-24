# Build stage
FROM node:20-alpine AS build
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY .npmrc ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src
COPY contracts ./contracts

# Build TypeScript
RUN npm run build

# Remove dev dependencies
RUN npm ci --omit=dev

# Production stage
FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app

# Copy built application
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/contracts ./contracts
COPY --from=build /app/package.json ./

# Environment
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"]

# Run application
CMD ["dist/index.js"]