#!/usr/bin/env bash
# One-time DNS cutover helper.
#
# The site deployments (deploy-site.yml) create only the records THEY own in the
# figureskatingtools.com zone:
#   - apex A (-> site Web App inbound IP) + asuid TXT   (prod)
#   - test CNAME -> site Web App default hostname       (test)
#     + asuid.test TXT
#
# Everything else that currently lives at the Joker registrar must also exist in the
# Azure zone BEFORE you repoint the name servers, or it breaks on cutover. This script
# seeds those non-site records idempotently. Run it once after the zone first exists
# and before delegating NS (re-running is safe).
#
# It does NOT manage the site records (Bicep does) and never deletes anything.
#
# Usage:  ./infra/seed-dns-records.sh
set -euo pipefail

RG="rg-fs-dns"
ZONE="figureskatingtools.com"

echo "Seeding non-site records into zone '$ZONE' (rg: $RG)..."

# --- Email (CRITICAL: receiving mail breaks without this) -----------------------
# Current Joker record:  @  MX  10 mail.joker.com
if ! az network dns record-set mx show -g "$RG" -z "$ZONE" -n "@" \
      --query "MXRecords[?exchange=='mail.joker.com']" -o tsv 2>/dev/null | grep -q .; then
  az network dns record-set mx add-record -g "$RG" -z "$ZONE" -n "@" \
    --exchange "mail.joker.com" --preference 10 -o none
fi

# --- judgepapers tool (App Service, lives in its own repo) -----------------------
# These ideally move into the judgepapers repo's own deployment that targets THIS
# zone; seeded here so the cutover doesn't take the tool down in the meantime.
az network dns record-set cname set-record -g "$RG" -z "$ZONE" -n "judgepapers" \
  --cname "app-fs-judgepapers-yb6bgkpr7dehk.azurewebsites.net" --ttl 300 -o none
az network dns record-set cname set-record -g "$RG" -z "$ZONE" -n "test.judgepapers" \
  --cname "app-fs-judgepapers-6sk7jbtiojqc4.azurewebsites.net" --ttl 300 -o none

# --- NOT seeded -----------------------------------------------------------------
# asuid (apex) is managed by infra/modules/dns.bicep again now that the apex is an
# App Service Web App rather than a Static Web App — the deploy publishes the Web
# App's current customDomainVerificationId. Do NOT hand-seed a stale token here.
#
# The SWA-era `_dnsauth` TXT record is obsolete; delete it at the prod cutover
# (see infra/MIGRATION.md).

echo "Done. Verify with:  az network dns record-set list -g $RG -z $ZONE -o table"
