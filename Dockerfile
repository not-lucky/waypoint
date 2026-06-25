FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./
# Ensure the non-root `node` user can write logs/ and request debug folders
# even when the container is run without a `logs/` bind-mount.
RUN chown -R node:node /app
EXPOSE 20128
USER node
CMD ["node", "src/index.js"]
