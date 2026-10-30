#!/bin/sh
# certbot deploy hook for the Community stack. Install it as
# /etc/letsencrypt/renewal-hooks/deploy/soundsible-community.sh; certbot runs
# it once for every certificate it renews, with RENEWED_LINEAGE set to that
# certificate's directory under /etc/letsencrypt/live.
set -eu

# Adapt both values for another deployment.
COMMUNITY_DIR=/opt/soundsible-community/deploy/community
TURN_HOST=turn.84-247-161-82.sslip.io

case "${RENEWED_LINEAGE:-}" in
  */"$TURN_HOST")
    # Coturn reads its own copy of the TURN certificate, not the live one.
    install -m 644 "$RENEWED_LINEAGE/fullchain.pem" "$COMMUNITY_DIR/certs/turn.crt"
    install -m 644 "$RENEWED_LINEAGE/privkey.pem" "$COMMUNITY_DIR/certs/turn.key"
    docker compose --env-file "$COMMUNITY_DIR/.env" \
      -f "$COMMUNITY_DIR/docker-compose.yml" restart coturn-tls
    ;;
  *)
    # The webroot authenticator does not reload Nginx, which keeps serving
    # the previous certificate until it does.
    nginx -t && systemctl reload nginx
    ;;
esac
