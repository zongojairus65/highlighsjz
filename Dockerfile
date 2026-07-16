# ============================
# STAGE 1: Python Collector
# ============================
FROM python:3.12-slim AS python-builder

WORKDIR /app
COPY collector/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY collector/collector.py .


# ============================
# STAGE 2: TypeScript API
# ============================
FROM node:22-alpine AS ts-builder

WORKDIR /app
COPY api-ts/package*.json ./
RUN npm ci
COPY api-ts/ .


# ============================
# STAGE 3: Go Cache Service
# ============================
FROM golang:1.23-alpine AS go-builder

WORKDIR /build
COPY api-go/go.mod api-go/go.sum ./
RUN go mod download
COPY api-go/ .
RUN CGO_ENABLED=0 GOOS=linux go build -o /livescore-go .


# ============================
# STAGE 4: Rust WebSocket
# ============================
FROM rust:1.81-slim-bookworm AS rust-builder

WORKDIR /build
COPY api-rust/Cargo.toml api-rust/Cargo.lock ./
COPY api-rust/src/ ./src/
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN cargo build --release
RUN cp /build/target/release/livescore-rust /livescore-rust


# ============================
# STAGE FINAL: Image légère
# ============================
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates libssl3 python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Copier tous les binaires et scripts depuis les stages précédents
COPY --from=python-builder /app /app/collector
COPY --from=ts-builder /app /app/api-ts
COPY --from=go-builder /livescore-go /usr/local/bin/
COPY --from=rust-builder /livescore-rust /usr/local/bin/

# Installer les dépendances Python dans le stage final
RUN pip3 install aiohttp aioredis --no-cache-dir

EXPOSE 3000 8080 9090

# Par défaut, ne rien faire — le docker-compose définit la commande
CMD ["bash"]
