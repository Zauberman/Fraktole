#!/usr/bin/env bash
# Generates a self-signed certificate for the Fraktole daemon (local/LAN use).
# Usage: scripts/selfsigned.sh [output-dir] [lan-ip...]
set -euo pipefail

OUT_DIR="${1:-./tls}"
IP_ARGS=("${@:2}")

mkdir -p "$OUT_DIR"
SAN="IP:127.0.0.1,DNS:localhost"
for ip in "${IP_ARGS[@]}"; do
  SAN="${SAN},IP:${ip}"
done

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$OUT_DIR/key.pem" \
  -out "$OUT_DIR/cert.pem" \
  -days 365 \
  -subj "/CN=fraktole" \
  -addext "subjectAltName=${SAN}"

echo "certificates written to $OUT_DIR/cert.pem and $OUT_DIR/key.pem"
echo "then set in your config:"
echo "  \"server\": { \"tls\": { \"cert\": \"$OUT_DIR/cert.pem\", \"key\": \"$OUT_DIR/key.pem\" } }"
