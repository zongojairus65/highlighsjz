# Stage 1: TypeScript API
FROM node:22-bookworm-slim AS ts-stage
WORKDIR /app
COPY api-ts/package*.json ./
RUN npm install
COPY api-ts/ .

# Stage 2: Go Cache Service
FROM golang:1.23-alpine AS go-stage
WORKDIR /build
COPY api-go/go.mod .
COPY api-go/ .
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -o /livescore-go .

# Stage 3: Rust WebSocket Client
FROM rust:1.81-slim-bookworm AS rust-stage
WORKDIR /build
COPY api-rust/Cargo.toml .
COPY api-rust/src/ ./src/
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN cargo build --release

# Stage finale : une seule image qui lance tout
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libssl3 python3 python3-pip bash \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages aiohttp aioredis

# Node.js complet, copié depuis ts-stage (même version, pas de mismatch)
COPY --from=ts-stage /usr/local /usr/local

WORKDIR /app
COPY --from=ts-stage /app ./ts
COPY --from=go-stage /livescore-go /usr/local/bin/livescore-go
COPY --from=rust-stage /build/target/release/livescore-rust /usr/local/bin/livescore-rust
COPY collector/collector.py /app/collector/collector.py

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
CMD ["/entrypoint.sh"]
