# ============================
# STAGE 1: Python Collector
# ============================
FROM python:3.12-slim AS python-stage
WORKDIR /app
COPY collector/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY collector/collector.py .


# ============================
# STAGE 2: TypeScript API
# ============================
FROM node:22-alpine AS ts-stage
WORKDIR /app
COPY api-ts/package*.json ./
RUN npm ci
COPY api-ts/ .


# ============================
# STAGE 3: Go Cache Service
# ============================
FROM golang:1.23-alpine AS go-stage
WORKDIR /build
COPY api-go/go.mod .
COPY api-go/ .
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -o /livescore-go .


# ============================
# STAGE 4: Rust WebSocket
# ============================
FROM rust:1.81-slim-bookworm AS rust-stage
WORKDIR /build
COPY api-rust/Cargo.toml .
COPY api-rust/src/ ./src/
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN cargo build --release && cp /build/target/release/livescore-rust /livescore-rust


# ============================
# STAGE FINAL
# ============================
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*

COPY --from=python-stage /app /app/python
COPY --from=ts-stage /app /app/typescript
COPY --from=go-stage /livescore-go /usr/local/bin/
COPY --from=rust-stage /livescore-rust /usr/local/bin/

RUN pip3 install aiohttp aioredis --no-cache-dir

EXPOSE 3000 8080 9090
CMD ["bash"]
