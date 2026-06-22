#!/bin/bash
# Double-click this file in Finder to start the chess server.
cd "$(dirname "$0")"

echo ""
echo "  ♟  Ethan's Chess — Local Server (HTTPS)"
echo ""

# Get the primary local IP
LOCAL_IP=$(ifconfig 2>/dev/null | grep 'inet ' | awk '{print $2}' | grep -v '^127\.' | head -1)

# Regenerate cert if missing or if IP changed
STORED_IP=$([ -f cert.pem ] && openssl x509 -in cert.pem -text -noout 2>/dev/null | grep 'IP Address' | head -1 | tr -d ' ' | cut -d: -f2)
if [ ! -f cert.pem ] || [ ! -f key.pem ] || [ "$STORED_IP" != "$LOCAL_IP" ]; then
  echo "  Generating HTTPS certificate for $LOCAL_IP ..."
  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes \
    -config <(cat <<EOF
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no
[dn]
CN = chess-local
[v3_req]
subjectAltName = IP:${LOCAL_IP},IP:127.0.0.1,DNS:localhost
EOF
) 2>/dev/null
  echo "  Done."
  echo ""
fi

# Print access URLs
for ip in $(ifconfig 2>/dev/null | grep 'inet ' | awk '{print $2}' | grep -v '^127\.'); do
  echo "  Open this on BOTH devices:  https://$ip:8808/"
done

echo ""
echo "  First visit: click Advanced → Proceed to $LOCAL_IP (unsafe)"
echo "  Press Ctrl+C to stop."
echo ""

# Serve through Vite so AGS API requests are proxied from the same HTTPS origin.
npm run dev
