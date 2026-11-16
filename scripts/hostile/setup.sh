#!/usr/bin/env bash
# Prepare the hostile-relay comparison (scripts/hostile/README.md): a throwaway test CA
# and a localhost certificate for the relays, a copy of webpki-roots with that CA added
# for the Vector driver (Vector compiles its roots in; nothing else in the copy differs),
# and the driver itself. Needs openssl, python3, cargo and a Vector checkout at ../Vector.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VECTOR="${VECTOR:-$HERE/../../../Vector}"
TLS="$HERE/tls"
DRIVER="$HERE/vector-driver"

mkdir -p "$TLS"
if [ ! -f "$TLS/relay.pem" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
    -subj "/CN=Armada Hostile Test CA" -keyout "$TLS/ca.key" -out "$TLS/ca.pem" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=localhost" \
    -keyout "$TLS/relay.key" -out "$TLS/relay.csr" 2>/dev/null
  printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n" > "$TLS/ext.cnf"
  openssl x509 -req -in "$TLS/relay.csr" -CA "$TLS/ca.pem" -CAkey "$TLS/ca.key" -CAcreateserial \
    -days 3650 -extfile "$TLS/ext.cnf" -out "$TLS/relay.pem" 2>/dev/null
fi

# The webpki-roots version Vector's lockfile pins, with the test CA as its first anchor.
cp "$VECTOR/crates/Cargo.lock" "$DRIVER/Cargo.lock"
version=$(awk '/^name = "webpki-roots"$/{getline; print}' "$DRIVER/Cargo.lock" | sed 's/version = "\(.*\)"/\1/' | grep '^1\.' | head -1)
src=$(ls -d "$HOME"/.cargo/registry/src/*/"webpki-roots-$version" 2>/dev/null | head -1)
if [ -z "$src" ]; then
  (cd "$DRIVER" && cargo fetch >/dev/null 2>&1) || true
  src=$(ls -d "$HOME"/.cargo/registry/src/*/"webpki-roots-$version" | head -1)
fi
rm -rf "$DRIVER/vendor/webpki-roots"
mkdir -p "$DRIVER/vendor"
cp -r "$src" "$DRIVER/vendor/webpki-roots"
openssl x509 -in "$TLS/ca.pem" -outform der -out "$TLS/ca.der"
python3 - "$TLS/ca.der" "$DRIVER/vendor/webpki-roots/src/lib.rs" <<'EOF'
import sys
data = open(sys.argv[1], "rb").read()
def tlv(b, i):
    l = b[i + 1]; j = i + 2
    if l & 0x80:
        n = l & 0x7F; l = int.from_bytes(b[j:j + n], "big"); j += n
    return b[i], j, j + l
_, s, _ = tlv(data, 0)
_, ts, te = tlv(data, s)
fields, i = [], ts
while i < te:
    tag, cs, ce = tlv(data, i); fields.append((tag, cs, ce)); i = ce
k = 1 if fields[0][0] == 0xA0 else 0
subject, spki = fields[k + 4], fields[k + 5]
lit = lambda bs: 'b"' + "".join(chr(c) if 32 <= c < 127 and chr(c) not in '"\\' else "\\x%02x" % c for c in bs) + '"'
anchor = "  // The hostile-relay test CA (scripts/hostile/setup.sh); nothing else here differs.\n  TrustAnchor {\n    subject: Der::from_slice(%s),\n    subject_public_key_info: Der::from_slice(%s),\n    name_constraints: None\n  },\n\n" % (lit(data[subject[1]:subject[2]]), lit(data[spki[1]:spki[2]]))
lib = open(sys.argv[2]).read()
at = lib.index("  TrustAnchor {")
open(sys.argv[2], "w").write(lib[:at] + anchor + lib[at:])
EOF

(cd "$DRIVER" && CARGO_TARGET_DIR="$DRIVER/target" cargo build)
echo "ready: $DRIVER/target/debug/vector-driver"
