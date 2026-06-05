#!/usr/bin/env bash
# One-time DNS cutover helper.
#
# The site deployments (deploy-site.yml) create only the records THEY own in the
# figureskatingtools.com zone:
#   - apex A (ALIAS -> prod SWA) + _dnsauth TXT      (prod)
#   - test CNAME -> test SWA                          (test)
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

# --- NOT seeded (review before cutover) -----------------------------------------
# asuid.figureskatingtools.com TXT = 22F89FE29DD489AB08E54794D5C97E081F331E6855AA59B59AE05E7356464005
#   Looks like a leftover App Service apex-validation token from before the SWA
#   migration (the site is now a Static Web App). Left out as stale. If the apex was
#   ever still bound to an App Service you'd re-add it with:
#     az network dns record-set txt add-record -g "$RG" -z "$ZONE" -n "asuid" \
#       --value "22F89FE29DD489AB08E54794D5C97E081F331E6855AA59B59AE05E7356464005"

echo "Done. Verify with:  az network dns record-set list -g $RG -z $ZONE -o table"
