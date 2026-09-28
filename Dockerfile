FROM oven/bun:alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:alpine
WORKDIR /app

# The gateway, not the ESP32, resolves YouTube and transcodes the bounded
# audio/JPEG streams. Keep these runtime tools out of the firmware image.
RUN apk add --no-cache ffmpeg python3 py3-pip && \
    python3 -m pip install --no-cache-dir --break-system-packages yt-dlp

COPY --from=builder /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./

# The gateway writes its local configuration and account data beneath /app.
# Keep the image-owned files writable for the unprivileged runtime user.
RUN mkdir -p /app/data && chown -R bun:bun /app

EXPOSE 3000 3100

# The compose deployment bind-mounts existing account data owned by the host.
# Retain the base image's runtime user so upgrades do not break persistence.
CMD ["bun", "run", "src/server.ts"]
