# syntax=docker/dockerfile:1

# -------- Build stage --------
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies first (better cache)
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts

# Copy sources
COPY src ./src
COPY start.js ./start.js

# Build TypeScript
RUN npm run build

# Prune dev dependencies and keep production only
RUN npm prune --omit=dev

# -------- Runtime stage --------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Copy only production node_modules and built dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./

# Default port
EXPOSE 3000

# Run the compiled server
CMD ["node", "dist/index.js"]
