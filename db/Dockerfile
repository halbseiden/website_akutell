# Stage 1: gosu aus aktuellem Quellcode mit neuer Go-Toolchain neu bauen.
# Das offizielle postgres-Image liefert ein gosu-Binary mit Go-stdlib
# v1.24.6, das CVE-2025-68121 (CRITICAL, crypto/tls) enthaelt. Solange
# das postgres-Team gosu nicht neu baut, ersetzen wir es selbst.
FROM golang:1.25-alpine AS gosu-builder

RUN apk add --no-cache git \
 && git clone --depth 1 https://github.com/tianon/gosu.git /src
WORKDIR /src
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -o /out/gosu .


FROM postgres:17-alpine

# Vorhandenes verwundbares gosu durch unsere frisch gebaute Version
# ersetzen. Pfad ist im offiziellen postgres-Image so verankert.
COPY --from=gosu-builder /out/gosu /usr/local/bin/gosu
RUN chmod +x /usr/local/bin/gosu

# Init-Skript wird beim ersten Start automatisch ausgefuehrt,
# solange das Daten-Volume (/var/lib/postgresql/data) leer ist.
COPY init.sql /docker-entrypoint-initdb.d/init.sql

EXPOSE 5432
