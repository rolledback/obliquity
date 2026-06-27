# syntax=docker/dockerfile:1

# ---- Build stage: compile the static site with Vite ----
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies first so this layer is cached unless the lockfile changes.
# npm ci installs devDependencies too (TypeScript, Vite), which the build needs.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source and produce the static bundle in /app/dist.
COPY . .
RUN npm run build

# ---- Serve stage: ship only the static files behind nginx ----
FROM nginx:1.27-alpine AS serve

# Replace the default site config with one tuned for this single-page app.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# The built site is just static assets (no Node runtime in the final image).
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# Lightweight liveness check so orchestrators can tell the container is serving.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1

# nginx:alpine's base image already runs `nginx -g 'daemon off;'`.
