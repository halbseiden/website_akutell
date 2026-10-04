FROM node:22-alpine AS builder

WORKDIR /app

# Dependencies separat installieren fuer besseres Layer-Caching:
# package.json aendert sich seltener als der Anwendungscode.
COPY package*.json ./
RUN npm ci --omit=dev


FROM node:22-alpine

WORKDIR /app

# npm-CLI aus dem Runtime-Image entfernen: enthaelt zur Laufzeit
# nicht benoetigte Tools (z. B. tar, brace-expansion, sigstore), die
# regelmaessig CVEs schleppen. Reduziert Angriffsfläche und
# Trivy-Befunde des Final-Images.
# apk upgrade: zieht gepatchte Alpine-Systempakete (z. B. OpenSSL), auch
# wenn das Base-Image selbst noch nicht neu gebaut wurde.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

COPY --from=builder /app/node_modules ./node_modules
COPY package.json server.js ./

EXPOSE 3000

# Nicht als root laufen: der unprivilegierte User `node` (UID 1000) ist im
# offiziellen Image bereits angelegt. Die App-Dateien gehören root und sind
# für `node` nur lesbar.
USER node

CMD ["node", "server.js"]
