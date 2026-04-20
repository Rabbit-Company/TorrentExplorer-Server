# ---------- Build stage ----------
FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json ./
RUN bun install

COPY src/ ./src/

RUN bun build src/index.ts --outfile torrent-explorer-server --target bun --compile --production

# ---------- Runtime stage ----------
FROM gcr.io/distroless/base-nossl-debian13

WORKDIR /app

COPY --from=builder /app/torrent-explorer-server /app/

EXPOSE 3000/tcp
CMD ["/app/torrent-explorer-server"]