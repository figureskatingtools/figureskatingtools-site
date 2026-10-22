"""figureskatingtools.com platform API — the central competition registry.

This Function App sits behind the site's router Web App (`server/server.js`),
which owns the Entra login and forwards every `/api/*` request here with

    X-Proxy-Secret:          the shared secret (PROXY_SHARED_SECRET)
    X-Forwarded-User-Tid:    the signed-in user's Entra tenant id (GUID)
    X-Forwarded-User-Oid:    their Entra object id (GUID) — the identity
    X-Forwarded-User-Email:  their e-mail, lowercased (display and audit only)
    X-Forwarded-User-Name:   their display name, percent-encoded
    X-Forwarded-User-Admin:  "1" for the router's admins (informational here)

The browser never reaches this app directly, but its hostname is public, so
the gate (`_require_user`) FAILS CLOSED: PROXY_SHARED_SECRET must be set and
match (constant-time), the identity comes only from the headers above, and the
tenant must be in ALLOWED_TENANT_IDS. Anything else is 401 (403
tenant_not_allowed for a foreign tenant). The e-mail header counts only when
it is printable ASCII (checked before lowercasing — see _normalize_email).
A route's {id} is normalised once to a lowercase GUID (anything else is
404 not_found) and only that spelling is ever used for a lookup.

Users and access — the platform owns an internal user id (GUID), decoupled
from the identity provider, and every grant references only that id:

    users              PK "USER",     RK <userId>        Email, DisplayName,
                                                          FirstSeenUtc, LastSeenUtc
                                                          (PII: this app only)
                       PK "SEARCHRATE", RK <userId>      MinuteStart/Count,
                                                          DayStart/Count
    useridentities     PK "IDENTITY", RK <tid>_<oid>     UserId, Tid, Oid,
                                                          Provider "entra", CreatedUtc
    competitionaccess  PK <competition guid>, RK <userId> Role owner|write|read,
                                                          GrantedBy (userId), GrantedUtc

The tools read `useridentities` + `competitionaccess` (platform_access.py in
each tool repo), never `users`. A first request from an unknown identity
creates the user (insert-then-reread on a race) and, once, claims the
competitions created before LEGACY_CLAIM_CUTOFF whose CreatedBy is that e-mail
and which never had an owner (claimed rows are marked LegacyClaimedUtc).
Exactly one owner row per competition, enforced by the ownership sentinel
(competitionaccess RowKey "_owner"): create, legacy claim and admin owner swap
all write it in the same table transaction as their owner rows. An admin
counts as owner everywhere; a user-route write that only the admin role
allowed is audited as `admin.override.<action>`. No access at all is a 404 not_found (existence never leaks), read
access on a write route 403 read_only, anything short of owner on an owner
route 403 owner_required:

    read   GET competition, list/download files, list HOVTP sources
    write  PUT/PATCH, extend, upload/delete file, HOVTP accept/reject/revoke
    owner  DELETE competition, manage access

HTTP contract (Azure Functions' default `api` route prefix makes these the
literal URLs the router proxies to — and the URLs
`packages/shared-ui/src/competition.ts` calls):

    GET    /api/competitions            -> 200 [Competition, ...]  (own + shared only)
    POST   /api/competitions            -> 201 Competition  (caller becomes owner)
                                           409 {"error": "code_in_use", ...}
    GET    /api/competitions/{id}       -> 200 Competition | 404
    PUT    /api/competitions/{id}       -> 200 Competition | 404
    PATCH  /api/competitions/{id}       -> 200 Competition | 404 | 409
    DELETE /api/competitions/{id}       -> 200 Competition (status "deleted") | 404
    POST   /api/competitions/{id}/extend -> 200 Competition (deletionDate + 7 days) | 404
    GET    /api/health                  -> 200 {"status": "ok"}

    GET    /api/competitions/{id}/access          -> 200 {"items": [Grant, ...]}  (owner)
    PUT    /api/competitions/{id}/access/{userId} -> 200 {"item": Grant}  (owner)
                                                     {"role": "read"|"write"}
    DELETE /api/competitions/{id}/access/{userId} -> 200 {"status": "removed", ...}
                                                     (owner, or the grantee itself =
                                                     leave; {userId} may be "me")
    GET    /api/users/search?q=         -> 200 {"items": [SearchHit, ...]}  (<= 8 hits,
                                           not yourself; 429 rate_limited at 30/min or
                                           300/day per user). q a full e-mail: exact
                                           match; else >= 3 chars of the NAME only
    GET    /api/users/recent            -> 200 {"items": [UserRef, ...]}
    GET    /api/users/me                -> 200 {"userId", "name", "email", "isAdmin"}

Grant = {"userId", "name", "email", "role"}; UserRef = {"userId", "name", "email"};
SearchHit = {"userId", "name", "email": str | null, "emailHint"}: `email` is
set for an exact e-mail match and for people the caller already shares a
competition with, else null with only the masked hint ("a•••@club.fi").

    timer  retention_sweep (03:00 UTC)  -> purges every competition past its
                                           deletionDate (see "Retention" below)

    GET    /api/competitions/{id}/files          -> 200 {"files": [FileInfo, ...]}
    POST   /api/competitions/{id}/files          -> 201 FileInfo
                                                    ?filename=&sourceTool=, raw body
    GET    /api/competitions/{id}/files/{name}   -> 200 bytes  (?source=upload|fsm)
    DELETE /api/competitions/{id}/files/{name}   -> 200 {"status": "deleted", ...}

    GET    /api/competitions/{id}/hovtp/sources              -> 200 {"sources": [Source, ...]}
    POST   /api/competitions/{id}/hovtp/sources/{ip}/accept  -> 200 {"source": Source,
                                                                     "attached": n, "failed": m}
                                                                {"days": 1|2|3|7}
    POST   /api/competitions/{id}/hovtp/sources/{ip}/reject  -> 200 {"source": Source,
                                                                     "deleted": n}
    DELETE /api/competitions/{id}/hovtp/sources/{ip}         -> 200 (revoke; same shape)

Competition JSON (both directions; server-owned fields are ignored on input):

    {
      "id":        "3f2b...-...",   GUID, server-assigned, immutable
      "code":      "winter-cup-2026",  unique, normalized slug
      "name":      "Winter Cup 2026",
      "date":      "2026-01-17",    start date, ISO yyyy-mm-dd, may be ""
      "endDate":   "2026-01-18",    may be ""
      "venue":     "Helsinki Ice Hall",  may be ""
      "createdBy": "user@example.com",
      "createdUtc":"2026-01-02T10:00:00Z",
      "updatedUtc":"2026-01-02T10:00:00Z",
      "deletionDate":"2026-03-04T00:00:00Z",  server-owned, see "Retention"
      "status":    "active" | "deleted",
      "access":    "owner" | "write" | "read",   the caller's (admin = owner)
      "owner":     {"userId", "name", "email"} | null
    }

FileInfo JSON (the shared competition file pool):

    {
      "name":        "FSKWSINGLES-----QUAL000100--_SegmentResults.pdf",
      "source":      "upload" | "fsm",
      "size":        123456,
      "contentType": "application/pdf",
      "uploadedUtc": "2026-01-02T10:00:00Z",
      "uploadedBy":  "user@example.com",
      "sourceTool":  "protocolgenerator"
    }

HOVTP source JSON (one FSM sender, identified by its client IP):

    {
      "ip":            "20.31.4.7",
      "origin":        "FSM1",          from the HOVTP headers, may be ""
      "venue":         "HTL",
      "discipline":    "FSK",
      "environment":   "Test" | "Production",
      "status":        "pending" | "accepted" | "rejected" | "expired",
      "firstSeenUtc":  "2026-01-02T10:00:00Z",
      "lastSeenUtc":   "2026-01-02T10:05:00Z",
      "messageCount":  42,
      "pendingCount":  3,               files waiting in quarantine
      "pendingBytes":  120034,
      "acceptedUntilUtc": "2026-01-09T10:00:00Z",   omitted when never accepted
      "acceptedBy":    "user@example.com"           omitted when never accepted
    }

"expired" is computed, never stored: an accepted source whose AcceptedUntilUtc
has passed reads back as expired so the UI re-prompts for it.

Admin routes (the /admin/ panel), gated by `_require_admin` — fail closed: the
proxy secret must be configured and match, the forwarded tid/oid must be
present with the tid allowed, and the router must have sent
X-Forwarded-User-Admin: 1 (it does so only for the Site.Admin app role; the
same trust the tool backends place in it). Every mutation writes an AUDIT
row to the `adminlog` table (see "Admin log" below):

    GET    /api/manage/competitions?status=active|deleted|purged|all
                                           -> 200 {"competitions": [AdminCompetition, ...]}
    GET    /api/manage/competitions/{id}   -> 200 {"competition", "files", "hovtp"}
    PATCH  /api/manage/competitions/{id}   -> 200 {"competition"}  (+ deletionDate;
                                              createdBy is read-only history: 400)
    PUT    /api/manage/competitions/{id}/owner -> 200 {"competition", "access"}
                                                  {"userId"} — one table transaction:
                                                  new owner in, old owner -> write
    GET    /api/manage/users[?q=]          -> 200 {"users": [AdminUser, ...]}  (q: name or
                                              e-mail substring, >= 3 chars, <= 8 hits)
    DELETE /api/manage/competitions/{id}   -> 200 {"competition"} | 409 deleted
    POST   /api/manage/competitions/{id}/restore -> 200 {"competition"}  {deletionDate?}
    POST   /api/manage/competitions/{id}/purge   -> 200 {"competition"} (tombstone)
                                                    {"confirm": "<code>"}
    POST   /api/manage/sweep/dry-run       -> 200 {"summary": {...}}
    GET    /api/manage/diagnostics         -> 200 {"config", "storage", "counts", "sweeps"}
    GET    /api/manage/audit?before=&limit= -> 200 {"entries": [...], "next": "<id>"|null}

AdminCompetition = Competition + startDate, extendedCount, lastExtendedUtc,
deleteReason, deletedUtc, purgedUtc, "clock" (the clock row and whether it is
in sync), with "status" derived: "purged" when PurgedUtc is set.

Every non-2xx body is {"error": "<machine_code>", "message": "<human text>"}.

Storage layout — one `competitions` table, four row kinds:

    PartitionKey="COMPETITION",  RowKey=<guid>              the competition itself
    PartitionKey="CODE",         RowKey=<normalized code>   -> CompetitionId
    PartitionKey="HOVTPSOURCE",  RowKey=<guid>_<ip>         one sender's trust row
    PartitionKey="HOVTPSESSION", RowKey=<session uuid>      LastSerial, Ip, UpdatedUtc

The CODE row is both the uniqueness constraint (inserted first, so a duplicate
fails atomically with 409) and the O(1) code->GUID lookup the HOVTP listener
uses. The HOVTPSOURCE and HOVTPSESSION rows belong to that listener (a separate
Function App, `infra/hovtp/`); this app only reads a source and flips it between
pending / accepted / rejected on the operator's behalf. Blob data lives in the
shared `competition-data` container keyed by GUID:

    <guid>/uploads/...           cross-tool data reuse (tool Function Apps get
                                 read-only RBAC here — see
                                 infra/modules/shared-data-access.bicep)
    <guid>/fsm/...               files delivered by the HOVTP listener, flat
    <guid>/fsm-pending/<ip>/...  quarantine for a source that is not accepted
                                 (yet); invisible to the file pool until an
                                 accept attaches it into <guid>/fsm/

Retention — ONE clock for the whole platform. The COMPETITION row owns
`DeletionDate` (midnight UTC of creation + RETENTION_DAYS). Its non-personal
part is mirrored into a separate table, `retentionclock` (PK "COMPETITION",
RK <guid lowercase>, columns `DeletionDate`, `Status`, `PurgedUtc` and nothing
else — keep the names, the tools' platform_clock.py depends on them): the tool
Function Apps can read only that table, never the registry rows with their
e-mail addresses and sender IPs, and delete their own linked records once the
clock says `Status == "deleted"` or `PurgedUtc`. Every write that changes one
of those values updates the mirror; the nightly sweep reconciles it in full. The operator's only lever is
POST …/extend (+EXTENSION_DAYS from max(current date, today), no cap). A manual
DELETE pulls the date to the next midnight. The nightly `retention_sweep`:

  1. backfills DeletionDate on rows that predate it (even in dry-run);
  2. purges each expired row: Status=deleted, CODE row released (only if it
     still points here), HOVTPSOURCE rows and every blob under `<guid>/`
     deleted, then the row is replaced by a TOMBSTONE — no e-mail addresses,
     PurgedUtc set — so the tools can tell "purged" from "never existed";
  3. re-sweeps `<guid>/` for two days after a purge (in-flight HOVTP writes);
  4. deletes HOVTPSESSION rows idle for HOVTP_SESSION_IDLE_DAYS;
  5. reconciles every COMPETITION row into the clock table;
  6. prunes the admin log: AUDIT rows after AUDIT_RETENTION_DAYS, SWEEP rows
     after SWEEP_LOG_RETENTION_DAYS;
  7. removes users unseen for INACTIVE_USER_DAYS who own no live competition:
     their grants, identity links, search counter and users row — the
     users row re-read first (skipped if seen since) and deleted
     etag-conditionally.

A purge (step 2, and the admin "Purge now") also deletes the competition's
competitionaccess rows; a soft delete keeps them, so a restore keeps its shares.

RETENTION_PURGE_ENABLED (app setting, Bicep-owned, on by default) must be
"true" for steps 2–4, 6 and 7 to delete anything; "false" is the kill switch —
they then only log what they would do. The admin "Purge now" is an explicit
action and does not obey it.

Admin log — table `adminlog` (ADMIN_LOG_TABLE), written only by this app:

    PartitionKey="AUDIT", RowKey=<inverted ticks>_<uuid>   Utc, Actor (the
        acting user's e-mail), Action, CompetitionId, CompetitionCode, Target
        (the e-mail an access change is about), Changes (JSON {field: [before,
        after]}, changed fields only), Outcome — admin mutations and every
        user's access changes (access.grant/change/revoke/leave/claim,
        competition.owner)
    PartitionKey="SWEEP", RowKey=<inverted ticks>_<uuid>   Utc, PurgeEnabled,
        DryRunManual, Summary (JSON) — one row per sweep run

Inverted ticks make ascending RowKey order newest first. Written after the
action succeeded, best effort: a failed write is logged, never rolled back.
"""

import hmac
import ipaddress
import json
import logging
import os
import re
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from urllib.parse import quote, unquote

import azure.functions as func
from azure.core import MatchConditions
from azure.core.exceptions import (
    ResourceExistsError,
    ResourceModifiedError,
    ResourceNotFoundError,
)
from azure.data.tables import TableClient, TableTransactionError, UpdateMode
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

COMPETITIONS_TABLE = "competitions"
# The retention clock as the tools see it — see the module docstring.
CLOCK_TABLE_DEFAULT = "retentionclock"
CLOCK_COLUMNS = ("DeletionDate", "Status", "PurgedUtc")
PK_COMPETITION = "COMPETITION"
PK_CODE = "CODE"
# Written by the HOVTP listener (infra/hovtp/); read — and, for the status
# field, written — here. Keep the column names in sync with that app.
PK_HOVTP_SOURCE = "HOVTPSOURCE"
PK_HOVTP_SESSION = "HOVTPSESSION"

STATUS_ACTIVE = "active"
STATUS_DELETED = "deleted"

# ── retention (one platform clock) ──
RETENTION_DAYS = 60
EXTENSION_DAYS = 7
# Rows created before DeletionDate existed get max(created + 60 d, this floor):
# no extension already granted in a tool may be cut short by the switch to the
# platform clock. Fixed on purpose — see CLAUDE.md "Competition registry".
LEGACY_DELETION_FLOOR = "2026-11-10T00:00:00Z"
AUTO_CLEANUP_ACTOR = "auto-cleanup"
DELETE_REASON_USER = "user"
HOVTP_SESSION_IDLE_DAYS = 30
# How long after a purge the sweep re-deletes `<guid>/`: a HOVTP push that had
# already resolved the competition can still land a blob after the purge.
RESWEEP_DAYS = 2
EXTEND_RETRIES = 5
_UTC_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
# Columns a purged competition keeps — none of them is personal data.
TOMBSTONE_COLUMNS = (
    "Code", "Name", "StartDate", "EndDate", "Venue", "CreatedUtc", "DeletedUtc",
    "DeleteReason", "DeletionDate", "ExtendedCount", "LastExtendedUtc",
)

# ── admin (/api/manage/*) ──
# The admin log: PK "AUDIT" rows (one per admin mutation, newest first by an
# inverted-ticks RowKey) and PK "SWEEP" rows (one per retention sweep run).
# Only this app has a grant on it — not the tools, not the HOVTP listener.
ADMIN_LOG_TABLE_DEFAULT = "adminlog"
PK_AUDIT = "AUDIT"
PK_SWEEP = "SWEEP"
AUDIT_RETENTION_DAYS = 365
SWEEP_LOG_RETENTION_DAYS = 30
SWEEP_HISTORY = 10
AUDIT_PAGE_DEFAULT = 50
AUDIT_PAGE_MAX = 200
# Derived, never stored: a tombstone (PurgedUtc set) reads back as purged.
STATUS_PURGED = "purged"
ADMIN_STATUS_FILTERS = (STATUS_ACTIVE, STATUS_DELETED, STATUS_PURGED, "all")
RESTORE_DEFAULT_DAYS = 7
MAX_EMAIL_LENGTH = 254
# DateTime.MaxValue.Ticks in .NET — the usual base of an inverted-ticks key.
_MAX_TICKS = 3155378975999999999
_TICKS_EPOCH = datetime(1, 1, 1, tzinfo=timezone.utc)
_ADMIN_LOG_KEY_RE = re.compile(r"^[0-9a-f_]{1,80}$")
_DELETION_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T00:00:00Z)?$")

# ── users and access ──
USERS_TABLE_DEFAULT = "users"
USER_IDENTITIES_TABLE_DEFAULT = "useridentities"
COMPETITION_ACCESS_TABLE_DEFAULT = "competitionaccess"
PK_USER = "USER"
PK_IDENTITY = "IDENTITY"
IDENTITY_PROVIDER_ENTRA = "entra"
# `Provider` of an Entra External ID identity row. Written only by the phase C
# linking code; until that exists, external identities never create a user
# (see _resolve_user and MigrationPending).
IDENTITY_PROVIDER_ENTRA_EXTERNAL = "entra-external"
ROLE_OWNER = "owner"
ROLE_WRITE = "write"
ROLE_READ = "read"
ROLE_RANK = {ROLE_READ: 1, ROLE_WRITE: 2, ROLE_OWNER: 3}
GRANTABLE_ROLES = (ROLE_READ, ROLE_WRITE)
# LastSeenUtc/Email/DisplayName are refreshed at most this often per process.
LAST_SEEN_REFRESH_SECONDS = 3600
USER_SEARCH_MIN_CHARS = 3
USER_SEARCH_MAX_RESULTS = 8
USER_SEARCH_MAX_QUERY = 100
# Per user, shared by every instance (users table, PK SEARCHRATE): enough for
# a type-ahead, too slow to scrape the directory.
USER_SEARCH_RATE_LIMIT = 30
USER_SEARCH_RATE_WINDOW_SECONDS = 60
USER_SEARCH_DAILY_LIMIT = 300
USER_SEARCH_DAY_WINDOW_SECONDS = 86400
PK_SEARCH_RATE = "SEARCHRATE"
RECENT_SHARE_USERS = 10
# A users row unseen this long, owning no live competition, is removed nightly.
INACTIVE_USER_DAYS = 365
# The legacy e-mail claim (_claim_legacy_competitions) only ever considers
# competitions created before this instant: the rollout of the access model.
# MUST be <= the moment the access model reaches prod — anything created
# after it already has an owner row from its create, and a later row must
# never be claimable by whoever signs in with its CreatedBy e-mail.
LEGACY_CLAIM_CUTOFF = "2026-10-19T09:30:00Z"
# The ownership sentinel: one row per competition in its competitionaccess
# partition (RowKey is not a GUID, so it is nobody's grant and the tools'
# point reads never see it). Every ownership change — create, legacy claim,
# admin owner swap — must insert it or win an etag-conditional write on it
# in the SAME table transaction as its owner rows, so two of them can never
# both land: there is never more than one owner row.
OWNER_LOCK_ROW_KEY = "_owner"
ME = "me"
# Always used with fullmatch: `$` with match() would accept a trailing "\n".
_GUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

MAX_NAME_LENGTH = 200
MAX_CODE_LENGTH = 64
MAX_VENUE_LENGTH = 200

DATA_CONTAINER = os.environ.get("COMPETITION_DATA_CONTAINER", "competition-data")

SOURCE_UPLOAD = "upload"
SOURCE_FSM = "fsm"
SOURCE_TOOL_HOVTP = "hovtp"

HOVTP_STATUS_PENDING = "pending"
HOVTP_STATUS_ACCEPTED = "accepted"
HOVTP_STATUS_REJECTED = "rejected"
HOVTP_STATUS_EXPIRED = "expired"
# The only trust windows the UI offers, and therefore the only ones accepted.
HOVTP_ACCEPT_DAYS = (1, 2, 3, 7)

POOL_MAX_FILE_SIZE = 50 * 1024 * 1024
MAX_FILENAME_LENGTH = 200
MAX_SOURCE_TOOL_LENGTH = 40

POOL_CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".xml": "application/xml",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
ALLOWED_FILE_EXTENSIONS = frozenset(POOL_CONTENT_TYPES)

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Control chars break HTTP headers; '#?%' break URLs (the blob name travels in
# the path of /api/competitions/{id}/files/{name}); '"' breaks Content-Disposition.
_FILENAME_STRIP_RE = re.compile(r'[\x00-\x1f\x7f#?%"]')
_SOURCE_TOOL_STRIP_RE = re.compile(r"[^a-zA-Z0-9_-]+")


# ── storage clients ───────────────────────────────────────────────────────────

def _data_account_name() -> str:
    """The account holding `competition-data` and the `competitions` table.

    The listener has its own host storage account now, so its
    AzureWebJobsStorage is NOT the platform account any more and the data
    account has to be named explicitly. The fallback keeps single-account and
    local setups working.
    """
    return (os.environ.get("COMPETITION_DATA_ACCOUNT")
            or os.environ.get("AzureWebJobsStorage__accountName") or "")


def get_table_client(table_name: str = COMPETITIONS_TABLE):
    """Table client via managed identity (deployed) or connection string (local)."""
    try:
        account_name = _data_account_name()
        if account_name:
            credential = DefaultAzureCredential()
            endpoint = f"https://{account_name}.table.core.windows.net"
            return TableClient(endpoint=endpoint, table_name=table_name, credential=credential)

        connection_string = os.environ.get("AzureWebJobsStorage")
        if connection_string:
            return TableClient.from_connection_string(conn_str=connection_string, table_name=table_name)

        return None
    except Exception as e:
        logging.error(f"Failed to create table client: {e}")
        return None


def get_blob_service_client():
    """Blob client via managed identity (deployed) or connection string (local)."""
    try:
        account_name = _data_account_name()
        if account_name:
            credential = DefaultAzureCredential()
            account_url = f"https://{account_name}.blob.core.windows.net"
            return BlobServiceClient(account_url=account_url, credential=credential)

        connection_string = os.environ.get("AzureWebJobsStorage")
        if connection_string:
            return BlobServiceClient.from_connection_string(connection_string)

        return None
    except Exception as e:
        logging.error(f"Failed to create blob client: {e}")
        return None


def competition_upload_prefix(competition_id: str) -> str:
    """Blob prefix for cross-tool competition uploads."""
    return f"{competition_id}/uploads/"


def competition_fsm_prefix(competition_id: str) -> str:
    """Blob prefix the HOVTP listener writes accepted FSM files into (flat)."""
    return f"{competition_id}/fsm/"


def competition_pending_prefix(competition_id: str, ip: str) -> str:
    """Quarantine prefix for one not-yet-accepted HOVTP source."""
    return f"{competition_id}/fsm-pending/{ip}/"


def hovtp_source_row_key(competition_id: str, ip: str) -> str:
    """RowKey of a HOVTPSOURCE row — one competition + one sender IP."""
    return f"{competition_id}_{ip}"


# ── auth: the fail-closed gate ────────────────────────────────────────────────
# This app's hostname is public. The only proof that a request came through
# the router is the shared secret, and the only identity is what the router
# put into the X-Forwarded-User-* headers after decoding Easy Auth's principal.
# No fallback: X-MS-CLIENT-PRINCIPAL*, Authorization: Bearer and the like are
# ignored, whoever sends them.

def _header(req: func.HttpRequest, name: str) -> str:
    return req.headers.get(name) or req.headers.get(name.lower()) or ""


def _proxy_secret_ok(req: func.HttpRequest) -> bool:
    """The router's X-Proxy-Secret, compared in constant time. FAILS CLOSED:
    an unset PROXY_SHARED_SECRET rejects every request."""
    expected = os.environ.get("PROXY_SHARED_SECRET") or ""
    if not expected:
        return False
    provided = _header(req, "X-Proxy-Secret")
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


def _allowed_tenant_ids() -> frozenset:
    """ALLOWED_TENANT_IDS (comma-separated) -> lowercased set. Empty = none."""
    raw = os.environ.get("ALLOWED_TENANT_IDS") or ""
    return frozenset(part.strip().lower() for part in raw.split(",") if part.strip())


def _external_tenant_ids() -> frozenset:
    """EXTERNAL_TENANT_IDS (comma-separated) -> lowercased set: the Entra
    External ID tenant(s). Empty = none configured."""
    raw = os.environ.get("EXTERNAL_TENANT_IDS") or ""
    return frozenset(part.strip().lower() for part in raw.split(",") if part.strip())


class MigrationPending(Exception):
    """An Entra External ID identity with no useridentities row yet. Until the
    linking code (phase C) exists, such an identity must not become a new
    user — it would be an orphan to merge later — so the request is refused
    with 503 migration_pending instead."""


_PRINTABLE_ASCII_RE = re.compile(r"[\x21-\x7e]+")


def _normalize_email(value) -> str:
    """An e-mail as this app compares and stores it: printable ASCII, at most
    MAX_EMAIL_LENGTH, lowercased — or '' (no e-mail at all). The ASCII test
    comes BEFORE lowercasing: str.lower() folds some non-ASCII letters into
    ASCII ones (U+212A KELVIN SIGN -> 'k'), which would let a look-alike
    address match an admin's or a legacy CreatedBy."""
    text = str(value or "").strip()
    if not _PRINTABLE_ASCII_RE.fullmatch(text) or len(text) > MAX_EMAIL_LENGTH:
        return ""
    return text.lower()


def _forwarded_identity(req: func.HttpRequest):
    """-> (tid, oid, email, name) from the router's headers, or None when the
    tid or the oid is missing or not a GUID. E-mail and name are display data:
    never used to decide anything (except the one-time legacy claim)."""
    tid = _header(req, "X-Forwarded-User-Tid").strip().lower()
    oid = _header(req, "X-Forwarded-User-Oid").strip().lower()
    if not _GUID_RE.fullmatch(tid) or not _GUID_RE.fullmatch(oid):
        return None
    email = _normalize_email(_header(req, "X-Forwarded-User-Email"))
    name = unquote(_header(req, "X-Forwarded-User-Name"), errors="replace").strip()
    return tid, oid, email, name[:MAX_NAME_LENGTH]


@dataclass(frozen=True)
class User:
    """The caller of a user route, after `_require_user`."""
    user_id: str
    email: str
    name: str
    is_admin: bool
    tid: str = ""
    oid: str = ""


def _require_user(req: func.HttpRequest):
    """-> User, or the 401/403/500 response to return.

    Order matters for the tests' "a rejected request touches no storage": the
    secret and the headers are checked before any table is read.
    """
    if not _proxy_secret_ok(req):
        logging.warning("Proxy shared secret unset, missing or mismatched; rejecting request")
        return _error("unauthorized", "Sign-in required.", 401)

    identity = _forwarded_identity(req)
    if identity is None:
        logging.warning("No forwarded identity (tid/oid) on request")
        return _error("unauthorized", "Sign-in required.", 401)
    tid, oid, email, name = identity

    # Defence in depth behind the router's own tenant check.
    if tid not in _allowed_tenant_ids():
        logging.warning(f"Tenant '{tid}' is not in ALLOWED_TENANT_IDS; rejecting request")
        return _error("tenant_not_allowed", "Accounts of your organisation cannot use this site.", 403)

    try:
        user_id = _resolve_user(tid, oid, email, name)
    except MigrationPending:
        logging.warning(f"External identity '{tid}_{oid}' has no platform user yet; migration pending")
        return _error("migration_pending",
                      "Sign-in with this account is not available yet.", 503)
    except Exception as e:
        logging.error(f"Could not resolve the user of identity '{tid}_{oid}': {e}")
        user_id = None
    if not user_id:
        return _error("storage_unavailable", "Could not look up the signed-in user.", 500)

    return User(user_id=user_id, email=email, name=name,
                is_admin=_forwarded_admin(req), tid=tid, oid=oid)


# ── users ─────────────────────────────────────────────────────────────────────
# One internal user id per person, decoupled from the identity provider: the
# Entra External ID move later adds a second useridentities row (new tid+oid)
# pointing at the same userId. How that link is made is the migration's
# problem — the data model just does not block it.

def _users_table_name() -> str:
    return os.environ.get("USERS_TABLE") or USERS_TABLE_DEFAULT


def _user_identities_table_name() -> str:
    return os.environ.get("USER_IDENTITIES_TABLE") or USER_IDENTITIES_TABLE_DEFAULT


def _access_table_name() -> str:
    return os.environ.get("COMPETITION_ACCESS_TABLE") or COMPETITION_ACCESS_TABLE_DEFAULT


# userId -> time.monotonic() of the last LastSeenUtc write by this process.
_LAST_SEEN_WRITES: dict = {}


def _create_row(client, entity) -> None:
    """create_entity, creating the table first when it is missing (local dev —
    Bicep creates them in Azure). ResourceExistsError propagates."""
    try:
        client.create_entity(entity)
    except ResourceNotFoundError:
        _ensure_table(client)
        client.create_entity(entity)


def _identity_row_key(tid: str, oid: str) -> str:
    return f"{tid}_{oid}"


def _resolve_user(tid: str, oid: str, email: str, name: str) -> str | None:
    """Identity -> userId; creates the user on the first request.

    Point read first. A new identity writes the users row, then INSERTS the
    identity row: two concurrent first requests both try, one insert wins and
    the loser drops its own users row and re-reads, so both converge on one
    userId. The winner alone runs the one-time legacy owner claim.

    An identity of an Entra External ID tenant (EXTERNAL_TENANT_IDS) with no
    identity row raises MigrationPending before anything is written: until
    the phase C linking code exists, it must not become a new user.
    """
    identities = get_table_client(_user_identities_table_name())
    users = get_table_client(_users_table_name())
    if identities is None or users is None:
        return None

    key = _identity_row_key(tid, oid)
    try:
        link = identities.get_entity(partition_key=PK_IDENTITY, row_key=key)
    except ResourceNotFoundError:
        link = None
    if link is not None and link.get("UserId"):
        _touch_user(users, link["UserId"], email, name)
        return link["UserId"]

    # Entra External ID: no new users until the linking code exists (phase C).
    # Decided before any write, so nothing is left behind.
    if tid in _external_tenant_ids():
        raise MigrationPending(key)

    user_id = str(uuid4())
    now = _now_utc()
    _create_row(users, {
        "PartitionKey": PK_USER,
        "RowKey": user_id,
        "Email": email,
        "DisplayName": name,
        "FirstSeenUtc": now,
        "LastSeenUtc": now,
    })
    try:
        _create_row(identities, {
            "PartitionKey": PK_IDENTITY,
            "RowKey": key,
            "UserId": user_id,
            "Tid": tid,
            "Oid": oid,
            "Provider": IDENTITY_PROVIDER_ENTRA,
            "CreatedUtc": now,
        })
    except ResourceExistsError:
        # A concurrent first request of the same identity won the insert.
        _delete_user_row(users, user_id)
        link = identities.get_entity(partition_key=PK_IDENTITY, row_key=key)
        winner = link.get("UserId") or None
        if winner:
            _touch_user(users, winner, email, name)
        return winner
    except Exception:
        _delete_user_row(users, user_id)
        raise

    _LAST_SEEN_WRITES[user_id] = time.monotonic()
    _claim_legacy_competitions(user_id, email)
    return user_id


def _delete_user_row(users, user_id: str) -> None:
    try:
        users.delete_entity(partition_key=PK_USER, row_key=user_id)
    except ResourceNotFoundError:
        pass
    except Exception as e:
        logging.warning(f"Could not delete the unused users row '{user_id}': {e}")


def _touch_user(users, user_id: str, email: str, name: str) -> None:
    """LastSeenUtc (and the current e-mail / display name) at most once an
    hour per process. Best effort: a missed write only makes the user look a
    little less recently seen. Upsert, so a missing users row is recreated."""
    now = time.monotonic()
    last = _LAST_SEEN_WRITES.get(user_id)
    if last is not None and now - last < LAST_SEEN_REFRESH_SECONDS:
        return
    updates = {"PartitionKey": PK_USER, "RowKey": user_id, "LastSeenUtc": _now_utc()}
    # The router leaves a header out rather than send something unusable;
    # never blank a stored value because of that.
    if email:
        updates["Email"] = email
    if name:
        updates["DisplayName"] = name
    try:
        users.upsert_entity(updates, mode=UpdateMode.MERGE)
        _LAST_SEEN_WRITES[user_id] = now
    except Exception as e:
        logging.warning(f"Could not refresh users row '{user_id}': {e}")


def _owner_lock_row(competition_id: str, owner_id: str, now: str) -> dict:
    """The competition's ownership sentinel (see OWNER_LOCK_ROW_KEY)."""
    return {"PartitionKey": _access_pk(competition_id), "RowKey": OWNER_LOCK_ROW_KEY,
            "OwnerUserId": owner_id, "UpdatedUtc": now}


def _owner_row(competition_id: str, owner_id: str, granted_by: str, now: str) -> dict:
    return {"PartitionKey": _access_pk(competition_id), "RowKey": owner_id, "Role": ROLE_OWNER,
            "GrantedBy": granted_by, "GrantedUtc": now}


def _establish_owner(access, competition_id: str, owner_id: str, granted_by: str) -> None:
    """First owner of a competition that has never had one (create, legacy
    claim): ONE transaction that INSERTS the ownership sentinel and the owner
    row. The insert of the sentinel is what serialises ownership — it fails
    (the whole transaction with it) once any create, claim or admin owner
    swap has established an owner. Raises the storage error on a lost race
    (ResourceExistsError / TableTransactionError) or a failure."""
    now = _now_utc()
    operations = [("create", _owner_lock_row(competition_id, owner_id, now)),
                  ("create", _owner_row(competition_id, owner_id, granted_by, now))]
    try:
        access.submit_transaction(operations)
    except ResourceNotFoundError:
        # The table itself is missing (local dev; Bicep creates it in Azure).
        _ensure_table(access)
        access.submit_transaction(operations)


def _claim_legacy_competitions(user_id: str, email: str) -> int:
    """One-time, at user creation: every competition created (CreatedBy) by
    this e-mail before LEGACY_CLAIM_CUTOFF that has never had an owner gets
    this user as its owner. The only place an e-mail grants anything.
    Rows nobody claims stay admin-only until an admin assigns an owner.

    Never twice: the claim writes the ownership sentinel (_establish_owner),
    so it loses to any owner a create, another claim or an admin swap has
    set, and it marks the COMPETITION row LegacyClaimedUtc, so a claimed row
    is never claimed again — not even after its owner's users row is removed
    and someone signs in anew with that e-mail.
    -> number of competitions claimed. Best effort: logged, never raised."""
    if not email:
        return 0
    table_client = get_table_client()
    access = get_table_client(_access_table_name())
    if table_client is None or access is None:
        return 0
    try:
        entities = list(table_client.query_entities(f"PartitionKey eq '{PK_COMPETITION}'"))
    except ResourceNotFoundError:
        return 0
    except Exception as e:
        logging.error(f"Legacy claim for '{user_id}': could not list competitions: {e}")
        return 0

    cutoff = _parse_utc(LEGACY_CLAIM_CUTOFF)
    claimed = 0
    for entity in entities:
        competition_id = _normalize_competition_id(entity.get("RowKey"))
        created = _parse_utc(entity.get("CreatedUtc"))
        if (not competition_id or entity.get("PurgedUtc") or entity.get("LegacyClaimedUtc")
                or created is None or created >= cutoff
                or _normalize_email(entity.get("CreatedBy")) != email):
            continue
        try:
            # Owner rows written before the sentinel existed count too.
            if _owner_rows(access, competition_id):
                continue
            _establish_owner(access, competition_id, user_id, user_id)
        except (ResourceExistsError, ResourceModifiedError, TableTransactionError):
            continue
        except Exception as e:
            logging.error(f"Legacy claim of '{competition_id}' for '{user_id}' failed: {e}")
            continue
        try:
            table_client.update_entity({"PartitionKey": PK_COMPETITION, "RowKey": competition_id,
                                        "LegacyClaimedUtc": _now_utc()}, mode=UpdateMode.MERGE)
        except Exception as e:
            # The sentinel alone already prevents a second claim.
            logging.warning(f"Could not mark '{competition_id}' as claimed: {e}")
        claimed += 1
        _audit(email, "access.claim", entity, {"role": [None, ROLE_OWNER]}, target=email)
    if claimed:
        logging.info(f"Legacy claim: user '{user_id}' now owns {claimed} competition(s)")
    return claimed


def _user_ref(user_id: str, row) -> dict:
    row = row or {}
    return {"userId": user_id, "name": row.get("DisplayName") or "",
            "email": row.get("Email") or ""}


def _read_users(user_ids, users=None) -> dict:
    """{userId: users row} for the ids that exist (point reads)."""
    users = users or get_table_client(_users_table_name())
    found = {}
    if users is None:
        return found
    for user_id in dict.fromkeys(user_ids):
        try:
            found[user_id] = users.get_entity(partition_key=PK_USER, row_key=user_id)
        except ResourceNotFoundError:
            continue
        except Exception as e:
            logging.warning(f"Could not read users row '{user_id}': {e}")
    return found


# ── access ────────────────────────────────────────────────────────────────────
# The single check point. Grants live in competitionaccess, keyed by the
# lowercase competition GUID (partition) and the userId (row); the tools read
# the same rows through platform_access.py.

def _normalize_competition_id(value) -> str:
    """The one spelling of a competition id: a lowercase GUID (what create
    writes), or '' for anything else — wrong shape, non-ASCII, surrounding
    whitespace or a trailing newline. Every route normalises {id} once with
    this and uses only the result for every entity, blob, HOVTP and access
    lookup, so two spellings can never reach two different rows."""
    if not isinstance(value, str) or not value.isascii():
        return ""
    lowered = value.lower()
    return lowered if _GUID_RE.fullmatch(lowered) else ""


def _route_competition_id(req: func.HttpRequest) -> str:
    """{id} of the route, normalised; '' => the caller answers 404 not_found."""
    return _normalize_competition_id(req.route_params.get("id"))


def _competition_not_found() -> func.HttpResponse:
    return _error("not_found", "Competition not found.", 404)


def _access_pk(competition_id: str) -> str:
    return str(competition_id or "").strip().lower()


def _access_rows(access, competition_id: str) -> list:
    try:
        return list(access.query_entities(f"PartitionKey eq '{_access_pk(competition_id)}'"))
    except ResourceNotFoundError:
        return []


def _owner_rows(access, competition_id: str) -> list:
    return [row for row in _access_rows(access, competition_id) if row.get("Role") == ROLE_OWNER]


def _user_grant_rows(access, user_id: str) -> list:
    """Every grant of one user — a RowKey filter, i.e. a small cross-partition
    scan. `user_id` is one of our GUIDs, so it is safe in the filter."""
    if not _GUID_RE.fullmatch(user_id or ""):
        return []
    try:
        return list(access.query_entities(f"RowKey eq '{user_id}'"))
    except ResourceNotFoundError:
        return []


class _Role(str):
    """The role a route was granted ('owner' | 'write' | 'read'), plus `own`:
    the caller's own stored grant (None when they have none). They differ
    only for an admin, who is owner everywhere — `_admin_override` tells
    whether a write went through on that alone."""
    own: str | None = None


def _stored_role(user: User, competition_id: str, access=None) -> str | None:
    """The caller's own competitionaccess role, or None. Storage errors propagate."""
    access = access or get_table_client(_access_table_name())
    if access is None:
        raise RuntimeError("access table configuration invalid")
    try:
        row = access.get_entity(partition_key=_access_pk(competition_id), row_key=user.user_id)
    except ResourceNotFoundError:
        return None
    role = row.get("Role")
    return role if role in ROLE_RANK else None


def _access_role(user: User, competition_id: str, access=None) -> _Role | None:
    """'owner' | 'write' | 'read' | None. An admin is owner everywhere (and
    their own grant, if any, is kept in `.own`). Storage errors propagate
    (the caller answers 500)."""
    own = _stored_role(user, competition_id, access)
    effective = ROLE_OWNER if user.is_admin else own
    if effective is None:
        return None
    role = _Role(effective)
    role.own = own
    return role


def _admin_override(user: User, role, need: str) -> bool:
    """True when `user` may do a `need`-level thing only because they are an
    admin: their own grant (role.own) falls short of it."""
    if not user.is_admin:
        return False
    return ROLE_RANK.get(getattr(role, "own", None) or "", 0) < ROLE_RANK[need]


def _audit_override(user: User, role, need: str, action: str, entity=None,
                    competition_id: str = "", changes=None, target: str = "") -> None:
    """After a successful user-route write: an `admin.override.<action>` AUDIT
    row when the admin role alone allowed it (no own grant good enough).
    Best effort, like every audit row."""
    if not _admin_override(user, role, need):
        return
    entity = entity if entity is not None else {"RowKey": competition_id}
    _audit(user.email, f"admin.override.{action}", entity, changes, target=target)


def _require_access(user: User, competition_id: str, need: str):
    """-> (role, None) or (None, error response). None at all -> 404
    not_found (the same answer as for a competition that does not exist),
    read on a write route -> 403 read_only, short of owner on an owner route
    -> 403 owner_required. Decided before any write. `competition_id` must
    already be normalised (_route_competition_id)."""
    if not competition_id or _normalize_competition_id(competition_id) != competition_id:
        return None, _competition_not_found()
    try:
        role = _access_role(user, competition_id)
    except Exception as e:
        logging.error(f"Could not read the access of '{user.user_id}' to '{competition_id}': {e}")
        return None, _error("internal_error", "Could not check access to the competition.", 500)
    if role is None:
        return None, _competition_not_found()
    if ROLE_RANK[role] < ROLE_RANK[need]:
        if need == ROLE_OWNER:
            return None, _error("owner_required",
                                "Only the owner can do this.", 403)
        return None, _error("read_only", "You have view-only access to this competition.", 403)
    return role, None


def _owner_ref(competition_id: str, access=None, users=None, cache=None):
    """{"userId", "name", "email"} of the competition's owner, or None."""
    access = access or get_table_client(_access_table_name())
    if access is None:
        return None
    try:
        owners = _owner_rows(access, competition_id)
    except Exception as e:
        logging.warning(f"Could not read the owner of '{competition_id}': {e}")
        return None
    if not owners:
        return None
    owner_id = sorted(owners, key=lambda row: row.get("GrantedUtc") or "")[-1]["RowKey"]
    if cache is not None and owner_id in cache:
        return cache[owner_id]
    ref = _user_ref(owner_id, _read_users([owner_id], users).get(owner_id))
    if cache is not None:
        cache[owner_id] = ref
    return ref


def _self_ref(user: User) -> dict:
    return {"userId": user.user_id, "name": user.name, "email": user.email}


def _competition_json(entity, user: User, role: str, owner_cache=None) -> dict:
    """entity_to_competition + the caller's `access` and the `owner`."""
    competition = entity_to_competition(entity)
    competition["access"] = role
    competition["owner"] = _owner_ref(entity.get("RowKey", ""), cache=owner_cache)
    return competition


def _grant_json(user_id: str, role: str, users_row) -> dict:
    ref = _user_ref(user_id, users_row)
    ref["role"] = role
    return ref


def _access_list(competition_id: str, access=None) -> list:
    """[Grant] — the owner first, then by name / e-mail. Raises on storage error."""
    access = access or get_table_client(_access_table_name())
    if access is None:
        raise RuntimeError("access table configuration invalid")
    rows = [row for row in _access_rows(access, competition_id) if row.get("Role") in ROLE_RANK]
    found = _read_users([row["RowKey"] for row in rows])
    items = [_grant_json(row["RowKey"], row["Role"], found.get(row["RowKey"])) for row in rows]
    items.sort(key=lambda item: (-ROLE_RANK[item["role"]],
                                 (item["name"] or item["email"]).lower(), item["userId"]))
    return items


# ── helpers ───────────────────────────────────────────────────────────────────

def _json(payload, status_code: int = 200) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(payload),
        status_code=status_code,
        mimetype="application/json",
    )


def _error(error_code: str, message: str, status_code: int, **extra) -> func.HttpResponse:
    body = {"error": error_code, "message": message}
    body.update(extra)
    return _json(body, status_code)


def _now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _utc_text(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime(_UTC_FORMAT)


def _parse_utc(value) -> datetime | None:
    """'2026-01-02T10:00:00Z' (or any ISO timestamp) -> aware datetime, else None."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _midnight(moment: datetime) -> datetime:
    """00:00 UTC of the moment's UTC calendar day."""
    moment = moment.astimezone(timezone.utc)
    return datetime(moment.year, moment.month, moment.day, tzinfo=timezone.utc)


def _initial_deletion_date(created: datetime) -> datetime:
    """Midnight UTC of (creation day + RETENTION_DAYS)."""
    return _midnight(created) + timedelta(days=RETENTION_DAYS)


def _effective_deletion_date(entity) -> datetime:
    """The row's DeletionDate, or — for a row that predates the column —
    max(created + RETENTION_DAYS, LEGACY_DELETION_FLOOR)."""
    stored = _parse_utc(entity.get("DeletionDate"))
    if stored is not None:
        return stored
    floor = _parse_utc(LEGACY_DELETION_FLOOR)
    created = _parse_utc(entity.get("CreatedUtc"))
    if created is None:
        return floor
    return max(_initial_deletion_date(created), floor)


def normalize_code(value: str) -> str:
    """
    Slugify a competition code into something that is both human-typable and a
    legal Table Storage RowKey: lowercase, diacritics folded to their base
    letter, runs of anything else collapsed to a single '-', trimmed. Returns
    '' when nothing usable is left.

    This MUST stay byte-for-byte equivalent to `normalizeCompetitionCode()` in
    packages/shared-ui/src/competition.ts — the client normalizes before POSTing
    and the server re-normalizes on arrival, so a divergence would let the same
    competition be created twice under two spellings of one code.
    """
    if not value:
        return ""
    # Same as JS `.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')`
    decomposed = unicodedata.normalize("NFD", str(value).lower())
    folded = "".join(c for c in decomposed if not ("\u0300" <= c <= "\u036f"))
    slug = re.sub(r"[^a-z0-9]+", "-", folded.strip()).strip("-")
    return slug[:MAX_CODE_LENGTH].strip("-")


def _clean(value, max_length: int) -> str:
    if value is None:
        return ""
    return str(value).strip()[:max_length]


def _valid_date(value: str) -> bool:
    """Empty is allowed; otherwise it must be a real yyyy-mm-dd date."""
    if not value:
        return True
    if not _DATE_RE.match(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def entity_to_competition(entity) -> dict:
    """Table row -> the wire shape documented at the top of this module."""
    return {
        "id": entity.get("RowKey", ""),
        "code": entity.get("Code", ""),
        "name": entity.get("Name", ""),
        "date": entity.get("StartDate", ""),
        "endDate": entity.get("EndDate", ""),
        "venue": entity.get("Venue", ""),
        "createdBy": entity.get("CreatedBy", ""),
        "createdUtc": entity.get("CreatedUtc", ""),
        "updatedUtc": entity.get("UpdatedUtc", ""),
        "deletionDate": _utc_text(_effective_deletion_date(entity)),
        "status": entity.get("Status", STATUS_ACTIVE),
    }


def _sort_key(competition: dict):
    # Newest competition first: by start date, then by creation time.
    return (competition.get("date") or "", competition.get("createdUtc") or "")


def _ensure_table(table_client) -> None:
    try:
        table_client.create_table()
    except Exception:
        # Already exists (or we lack create rights but the table is there).
        pass


def _read_body(req: func.HttpRequest) -> dict | None:
    """Returns the parsed JSON object, or None when the body isn't one."""
    try:
        body = req.get_json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def _get_competition_entity(table_client, competition_id: str):
    try:
        return table_client.get_entity(partition_key=PK_COMPETITION, row_key=competition_id)
    except ResourceNotFoundError:
        return None


def _release_code_row(table_client, code: str, competition_id: str) -> bool:
    """Free a code — but only while its CODE row still points at this
    competition: after a delete the code may already be reused, and that new
    owner's reservation must survive. -> False when storage failed (retry)."""
    if not code:
        return True
    try:
        row = table_client.get_entity(partition_key=PK_CODE, row_key=code)
    except ResourceNotFoundError:
        return True
    except Exception as e:
        logging.warning(f"Could not read CODE row '{code}': {e}")
        return False
    if (row.get("CompetitionId") or "") != competition_id:
        return True
    try:
        table_client.delete_entity(
            partition_key=PK_CODE, row_key=code,
            etag=_entity_etag(row), match_condition=MatchConditions.IfNotModified,
        )
    except ResourceNotFoundError:
        pass
    except ResourceModifiedError:
        # Re-claimed between the read and the delete — not ours any more.
        pass
    except Exception as e:
        logging.warning(f"Could not release CODE row '{code}': {e}")
        return False
    return True


def _entity_etag(entity):
    metadata = getattr(entity, "metadata", None) or {}
    return metadata.get("etag")


def _clock_table_name() -> str:
    return os.environ.get("RETENTION_CLOCK_TABLE") or CLOCK_TABLE_DEFAULT


def _clock_row(entity) -> dict:
    """COMPETITION row -> its clock row: the three columns, nothing personal."""
    row = {
        "PartitionKey": PK_COMPETITION,
        "RowKey": str(entity.get("RowKey") or "").strip().lower(),
        "DeletionDate": _utc_text(_effective_deletion_date(entity)),
        "Status": entity.get("Status") or STATUS_ACTIVE,
    }
    if entity.get("PurgedUtc"):
        row["PurgedUtc"] = entity.get("PurgedUtc")
    return row


def _clock_differs(wanted: dict, existing) -> bool:
    if existing is None:
        return True
    return any((wanted.get(c) or "") != (existing.get(c) or "") for c in CLOCK_COLUMNS)


def _sync_clock(entity, clock_client=None) -> bool:
    """Mirror one competition into the clock table (replace, so no stray
    column survives). Best effort: the API call that changed the competition
    has already succeeded, and the nightly reconcile heals a missed write."""
    try:
        client = clock_client or get_table_client(_clock_table_name())
        if client is None:
            return False
        row = _clock_row(entity)
        if not row["RowKey"]:
            return False
        try:
            client.upsert_entity(row, mode=UpdateMode.REPLACE)
        except ResourceNotFoundError:
            # Table missing (local dev); Bicep creates it in Azure.
            _ensure_table(client)
            client.upsert_entity(row, mode=UpdateMode.REPLACE)
        return True
    except Exception as e:
        logging.warning(f"Could not update the retention clock of '{entity.get('RowKey')}': {e}")
        return False


def _reconcile_clock(table_client, clock_client) -> tuple[int, bool]:
    """Bring every clock row in line with its COMPETITION row; write only the
    ones that differ. -> (rows written, all succeeded)."""
    try:
        competitions = list(table_client.query_entities(f"PartitionKey eq '{PK_COMPETITION}'"))
    except Exception as e:
        logging.error(f"Retention: could not list competitions for the clock reconcile: {e}")
        return 0, False
    try:
        existing = {
            row.get("RowKey"): row
            for row in clock_client.query_entities(f"PartitionKey eq '{PK_COMPETITION}'")
        }
    except ResourceNotFoundError:
        _ensure_table(clock_client)   # first run against a fresh table (local dev)
        existing = {}
    except Exception as e:
        logging.error(f"Retention: could not read the clock table: {e}")
        return 0, False
    written = 0
    ok = True
    for entity in competitions:
        wanted = _clock_row(entity)
        if not wanted["RowKey"] or not _clock_differs(wanted, existing.get(wanted["RowKey"])):
            continue
        if _sync_clock(entity, clock_client):
            written += 1
        else:
            ok = False
    return written, ok


def _delete_code_row(table_client, code: str) -> None:
    """Best-effort: a stale CODE row only blocks reuse of that one code."""
    if not code:
        return
    try:
        table_client.delete_entity(partition_key=PK_CODE, row_key=code)
    except ResourceNotFoundError:
        pass
    except Exception as e:
        logging.warning(f"Could not delete CODE row '{code}': {e}")


# ── file pool helpers ─────────────────────────────────────────────────────────

def _get_container_client():
    """Client for the shared `competition-data` container, or None."""
    service = get_blob_service_client()
    if service is None:
        return None
    try:
        return service.get_container_client(DATA_CONTAINER)
    except Exception as e:
        logging.error(f"Failed to create container client: {e}")
        return None


def sanitize_pool_filename(value) -> tuple[str, str]:
    """
    Reduce a client-supplied filename to a safe, flat blob name.

    Returns (name, "") on success or ("", error_code) with error_code one of
    'invalid_filename' / 'unsupported_type'. Directory components are dropped
    outright, so no name can ever escape the competition's own prefix.
    """
    raw = str(value or "").strip()
    # basename() alone is POSIX-only; Windows-style separators are folded first.
    name = os.path.basename(raw.replace("\\", "/")).strip()
    name = _FILENAME_STRIP_RE.sub("", name).strip()

    if not name or name in (".", ".."):
        return "", "invalid_filename"
    if len(name) > MAX_FILENAME_LENGTH:
        return "", "invalid_filename"

    extension = os.path.splitext(name)[1].lower()
    if extension not in ALLOWED_FILE_EXTENSIONS:
        return "", "unsupported_type"

    return name, ""


def _pool_content_type(name: str) -> str:
    return POOL_CONTENT_TYPES.get(os.path.splitext(name)[1].lower(), "application/octet-stream")


def _pool_prefix(competition_id: str, source: str) -> str:
    if source == SOURCE_FSM:
        return competition_fsm_prefix(competition_id)
    return competition_upload_prefix(competition_id)


def _ascii_metadata(value) -> str:
    """Blob metadata rides in HTTP headers, which must be ASCII."""
    return str(value or "").encode("ascii", "replace").decode("ascii")[:256]


def _metadata_value(metadata, key: str) -> str:
    """Case-insensitive read — metadata keys come back from Azure as headers."""
    for existing_key, existing_value in (metadata or {}).items():
        if existing_key.lower() == key.lower():
            return existing_value or ""
    return ""


def _iso_utc(value) -> str:
    if not value:
        return ""
    try:
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (AttributeError, TypeError, ValueError):
        return str(value)


def _file_info(name: str, source: str, properties) -> dict:
    """Blob properties (from list_blobs or get_blob_properties) -> FileInfo."""
    metadata = getattr(properties, "metadata", None) or {}
    content_settings = getattr(properties, "content_settings", None)
    content_type = getattr(content_settings, "content_type", None) or _pool_content_type(name)
    return {
        "name": name,
        "source": source,
        "size": getattr(properties, "size", 0) or 0,
        "contentType": content_type,
        "uploadedUtc": _iso_utc(getattr(properties, "last_modified", None)),
        "uploadedBy": _metadata_value(metadata, "uploadedBy"),
        "sourceTool": _metadata_value(metadata, "sourceTool"),
    }


def _load_competition(competition_id: str):
    """(entity, None) or (None, error response) — shared by every file route."""
    table_client = get_table_client()
    if not table_client:
        return None, _error("storage_unavailable", "Storage configuration invalid.", 500)

    try:
        entity = _get_competition_entity(table_client, competition_id)
    except Exception as e:
        logging.error(f"Error reading competition '{competition_id}': {e}")
        return None, _error("internal_error", "Could not read the competition.", 500)

    if entity is None:
        return None, _error("not_found", "Competition not found.", 404)

    return entity, None


def _requested_source(req: func.HttpRequest) -> str | None:
    """`?source=upload|fsm`, defaulting to uploads. None => invalid value."""
    source = (req.params.get("source") or SOURCE_UPLOAD).strip().lower()
    return source if source in (SOURCE_UPLOAD, SOURCE_FSM) else None


def _route_file_name(req: func.HttpRequest) -> str:
    """The {name} route param, rejected unless it is one plain path segment."""
    name = (req.route_params.get("name") or "").strip()
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        return ""
    return name


# ── HOVTP source helpers ──────────────────────────────────────────────────────
# A "source" is one FSM sender, identified only by its client IP: FSM sends no
# credentials, so trust is granted per IP for a fixed window. The listener app
# creates and touches these rows; the routes below are the operator's side of
# that contract — accept (attach the quarantined files), reject, revoke.

def _canonical_ip(text) -> str:
    """One canonical spelling of an IP, or '' when it isn't one at all.

    The IP is both a RowKey suffix and a blob path segment, so it must be
    normalized the same way here and in the listener: an address that reads
    back differently would strand its own quarantine.
    """
    try:
        address = ipaddress.ip_address(str(text or "").strip())
    except ValueError:
        return ""
    if isinstance(address, ipaddress.IPv6Address):
        # Drop any scope id ('fe80::1%eth0'): it is local to the sender's host.
        address = ipaddress.IPv6Address(address.packed)
    return str(address)


def _route_ip(req: func.HttpRequest) -> str:
    """The {ip} route param, canonicalised. '' => the caller answers 400."""
    return _canonical_ip(req.route_params.get("ip"))


def _int_column(entity, column: str) -> int:
    try:
        return int(entity.get(column) or 0)
    except (TypeError, ValueError):
        return 0


def _source_status(entity, now: str) -> str:
    """Stored status, except that an elapsed acceptance reads back as expired.

    Both timestamps are the same fixed-width UTC format, so comparing them as
    strings is the same as comparing the instants.
    """
    status = entity.get("Status") or HOVTP_STATUS_PENDING
    if status == HOVTP_STATUS_ACCEPTED:
        accepted_until = entity.get("AcceptedUntilUtc") or ""
        if not accepted_until or accepted_until <= now:
            return HOVTP_STATUS_EXPIRED
    return status


def _source_to_json(entity, now: str) -> dict:
    """HOVTPSOURCE row -> the wire shape documented at the top of this module."""
    source = {
        "ip": entity.get("Ip", ""),
        "origin": entity.get("Origin", ""),
        "venue": entity.get("Venue", ""),
        "discipline": entity.get("Discipline", ""),
        "environment": entity.get("Environment", ""),
        "status": _source_status(entity, now),
        "firstSeenUtc": entity.get("FirstSeenUtc", ""),
        "lastSeenUtc": entity.get("LastSeenUtc", ""),
        "messageCount": _int_column(entity, "MessageCount"),
        "pendingCount": _int_column(entity, "PendingCount"),
        "pendingBytes": _int_column(entity, "PendingBytes"),
    }
    accepted_until = entity.get("AcceptedUntilUtc") or ""
    if accepted_until:
        source["acceptedUntilUtc"] = accepted_until
    accepted_by = entity.get("AcceptedBy") or ""
    if accepted_by:
        source["acceptedBy"] = accepted_by
    return source


def _list_hovtp_source_entities(table_client, competition_id: str):
    """Every source row of one competition, via a RowKey range scan.

    RowKey is '<guid>_<ip>', so the competition's rows are exactly the range
    from '<guid>_' up to '<guid>`' — '`' is the character right after '_'.
    """
    low = hovtp_source_row_key(competition_id, "")
    high = f"{competition_id}`"
    return table_client.query_entities(
        f"PartitionKey eq '{PK_HOVTP_SOURCE}'"
        f" and RowKey ge '{low}' and RowKey lt '{high}'"
    )


def _load_hovtp_source(table_client, competition_id: str, ip: str):
    try:
        return table_client.get_entity(
            partition_key=PK_HOVTP_SOURCE,
            row_key=hovtp_source_row_key(competition_id, ip),
        )
    except ResourceNotFoundError:
        return None


def _pending_blob_names(container, competition_id: str, ip: str):
    """(full name, bare name) for every flat blob in one source's quarantine."""
    prefix = competition_pending_prefix(competition_id, ip)
    for blob in container.list_blobs(name_starts_with=prefix, include=["metadata"]):
        name = blob.name[len(prefix):]
        if not name or "/" in name:
            continue
        yield blob, name


def _pending_totals(container, competition_id: str, ip: str) -> tuple[int, int]:
    """(file count, total bytes) currently quarantined for one source."""
    count = 0
    total = 0
    for blob, _name in _pending_blob_names(container, competition_id, ip):
        count += 1
        total += getattr(blob, "size", 0) or 0
    return count, total


def _attach_pending(container, competition_id: str, ip: str, email: str) -> tuple[int, int]:
    """Move a source's quarantined files into the pool. -> (attached, failed).

    Download + upload rather than start_copy_from_url: server-side copy from a
    private container needs a SAS or bearer token on the source URL, which the
    managed identity here cannot mint. The files are small (PDFs and ODF XML).

    A per-file failure is tolerated and counted: the source blob is deleted only
    after its copy landed, so a retried accept re-attaches whatever failed.
    """
    attached = 0
    failed = 0
    for blob, name in list(_pending_blob_names(container, competition_id, ip)):
        try:
            source_blob = container.get_blob_client(blob.name)
            data = source_blob.download_blob().readall()
            content_settings = getattr(blob, "content_settings", None)
            content_type = (getattr(content_settings, "content_type", None)
                            or _pool_content_type(name))
            container.upload_blob(
                name=competition_fsm_prefix(competition_id) + name,
                data=data,
                overwrite=True,
                metadata={
                    **(getattr(blob, "metadata", None) or {}),
                    "attachedBy": _ascii_metadata(email),
                    "attachedUtc": _now_utc(),
                },
                content_settings=ContentSettings(content_type=content_type),
            )
            source_blob.delete_blob()
            attached += 1
        except Exception as e:
            logging.error(f"Could not attach '{blob.name}' for competition "
                          f"'{competition_id}': {e}")
            failed += 1
    return attached, failed


def _delete_pending(container, competition_id: str, ip: str) -> int:
    """Drop a source's quarantine. -> number of files deleted."""
    deleted = 0
    for blob, _name in list(_pending_blob_names(container, competition_id, ip)):
        try:
            container.get_blob_client(blob.name).delete_blob()
            deleted += 1
        except ResourceNotFoundError:
            pass
        except Exception as e:
            logging.error(f"Could not delete quarantined '{blob.name}': {e}")
    return deleted


def _merge_hovtp_source(table_client, competition_id: str, ip: str, updates: dict) -> None:
    table_client.update_entity(
        {
            "PartitionKey": PK_HOVTP_SOURCE,
            "RowKey": hovtp_source_row_key(competition_id, ip),
            **updates,
        },
        mode=UpdateMode.MERGE,
    )


def _hovtp_request(req: func.HttpRequest):
    """Gate + write access + route params shared by the per-source routes.

    -> ((competition_id, ip, user, role), None) or (None, error response).
    """
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return None, user

    competition_id = _route_competition_id(req)
    if not competition_id:
        return None, _competition_not_found()

    role, error = _require_access(user, competition_id, ROLE_WRITE)
    if error is not None:
        return None, error

    ip = _route_ip(req)
    if not ip:
        return None, _error("invalid_ip", "A valid source IP address is required.", 400)

    return (competition_id, ip, user, role), None


# ── request handlers ──────────────────────────────────────────────────────────
# The @app.route entry points below are thin adapters; all logic lives in these
# plain functions so the test suite can drive them without the Functions host.

def _list_competitions(req: func.HttpRequest) -> func.HttpResponse:
    """The caller's own and shared competitions — admins included: their
    view of everything is /api/manage, so the home page stays personal."""
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user

    include_deleted = (req.params.get("includeDeleted") or "").lower() in ("1", "true", "yes")

    table_client = get_table_client()
    access = get_table_client(_access_table_name())
    if not table_client or access is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    try:
        competitions = []
        owners = {}
        for grant in _user_grant_rows(access, user.user_id):
            role = ROLE_OWNER if user.is_admin else grant.get("Role")
            if role not in ROLE_RANK:
                continue
            entity = _get_competition_entity(table_client, grant.get("PartitionKey", ""))
            if entity is None or entity.get("PurgedUtc"):
                continue
            competition = _competition_json(entity, user, role, owners)
            if not include_deleted and competition["status"] == STATUS_DELETED:
                continue
            competitions.append(competition)

        competitions.sort(key=_sort_key, reverse=True)
        return _json(competitions)
    except Exception as e:
        logging.error(f"Error listing competitions: {e}")
        return _error("internal_error", "Could not list competitions.", 500)


def _create_competition(req: func.HttpRequest) -> func.HttpResponse:
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user
    email = user.email

    body = _read_body(req)
    if body is None:
        return _error("invalid_body", "Expected a JSON object body.", 400)

    name = _clean(body.get("name"), MAX_NAME_LENGTH)
    if not name:
        return _error("invalid_name", "A competition name is required.", 400)

    # An explicit code wins; otherwise slug the name. Either way it's normalized,
    # so 'Winter Cup 2026' and 'winter-cup-2026' collide as they should.
    code = normalize_code(body.get("code") or name)
    if not code:
        return _error("invalid_code", "The competition code must contain letters or digits.", 400)

    start_date = _clean(body.get("date") or body.get("startDate"), 10)
    end_date = _clean(body.get("endDate"), 10)
    if not _valid_date(start_date) or not _valid_date(end_date):
        return _error("invalid_date", "Dates must be in yyyy-mm-dd format.", 400)

    venue = _clean(body.get("venue"), MAX_VENUE_LENGTH)

    table_client = get_table_client()
    if not table_client:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    _ensure_table(table_client)

    competition_id = str(uuid4())
    now = _now_utc()

    # 1. Claim the code first. A duplicate fails here, atomically, before any
    #    competition row exists — so a 409 never leaves debris behind.
    try:
        table_client.create_entity({
            "PartitionKey": PK_CODE,
            "RowKey": code,
            "CompetitionId": competition_id,
            "CreatedUtc": now,
        })
    except ResourceExistsError:
        return _error("code_in_use", f"The competition code '{code}' is already in use.", 409, code=code)
    except Exception as e:
        logging.error(f"Error reserving competition code '{code}': {e}")
        return _error("internal_error", "Could not create the competition.", 500)

    # 2. Write the competition itself; compensate the claim if this fails.
    entity = {
        "PartitionKey": PK_COMPETITION,
        "RowKey": competition_id,
        "Code": code,
        "Name": name,
        "StartDate": start_date,
        "EndDate": end_date,
        "Venue": venue,
        "CreatedBy": email,
        "CreatedUtc": now,
        "UpdatedUtc": now,
        "Status": STATUS_ACTIVE,
        "DeletionDate": _utc_text(_initial_deletion_date(_parse_utc(now))),
        "ExtendedCount": 0,
    }
    try:
        table_client.create_entity(entity)
    except Exception as e:
        logging.error(f"Error creating competition '{code}', rolling back code reservation: {e}")
        _delete_code_row(table_client, code)
        return _error("internal_error", "Could not create the competition.", 500)

    # 3. The creator becomes its owner; without that row nobody but an admin
    #    could ever see it, so a failure here undoes the whole create.
    try:
        access = get_table_client(_access_table_name())
        if access is None:
            raise RuntimeError("access table configuration invalid")
        _establish_owner(access, competition_id, user.user_id, user.user_id)
    except Exception as e:
        logging.error(f"Error writing the owner of '{code}', rolling back the create: {e}")
        try:
            table_client.delete_entity(partition_key=PK_COMPETITION, row_key=competition_id)
        except Exception as cleanup_error:
            logging.error(f"Could not remove competition row '{competition_id}': {cleanup_error}")
        _delete_code_row(table_client, code)
        return _error("internal_error", "Could not create the competition.", 500)

    _sync_clock(entity)
    return _json(_competition_json(entity, user, ROLE_OWNER), 201)


def _get_competition(req: func.HttpRequest) -> func.HttpResponse:
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user

    competition_id = _route_competition_id(req)
    if not competition_id:
        return _competition_not_found()

    role, error = _require_access(user, competition_id, ROLE_READ)
    if error is not None:
        return error

    table_client = get_table_client()
    if not table_client:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    try:
        entity = _get_competition_entity(table_client, competition_id)
    except Exception as e:
        logging.error(f"Error reading competition '{competition_id}': {e}")
        return _error("internal_error", "Could not read the competition.", 500)

    if entity is None:
        return _error("not_found", "Competition not found.", 404)

    return _json(_competition_json(entity, user, role))


def _apply_competition_edit(table_client, entity, body: dict, extra_updates=None, etag=None):
    """The editable-field half of PUT/PATCH, shared by the user route and the
    admin route: validate `body`, claim a renamed code, merge the write,
    release the old code. -> (merged entity, None) or (None, error response).

    `extra_updates` are already-validated columns written in the same merge
    (the admin route's owner and deletion date). With `etag` the write is
    conditional: ResourceModifiedError is re-raised AFTER a fresh code claim
    has been compensated, so the caller can re-read the row and retry.
    """
    competition_id = entity.get("RowKey", "")
    updates = {}

    if "name" in body:
        name = _clean(body.get("name"), MAX_NAME_LENGTH)
        if not name:
            return None, _error("invalid_name", "A competition name is required.", 400)
        updates["Name"] = name

    for field, column, max_length in (("date", "StartDate", 10), ("endDate", "EndDate", 10)):
        if field in body:
            value = _clean(body.get(field), max_length)
            if not _valid_date(value):
                return None, _error("invalid_date", "Dates must be in yyyy-mm-dd format.", 400)
            updates[column] = value

    if "startDate" in body and "date" not in body:
        value = _clean(body.get("startDate"), 10)
        if not _valid_date(value):
            return None, _error("invalid_date", "Dates must be in yyyy-mm-dd format.", 400)
        updates["StartDate"] = value

    if "venue" in body:
        updates["Venue"] = _clean(body.get("venue"), MAX_VENUE_LENGTH)

    old_code = entity.get("Code", "")
    new_code = old_code
    if "code" in body:
        new_code = normalize_code(body.get("code"))
        if not new_code:
            return None, _error("invalid_code",
                                "The competition code must contain letters or digits.", 400)

    renaming = new_code != old_code

    # Rename = claim the new code first (409 if taken), then update, then release
    # the old one. Same ordering as create, for the same reason.
    if renaming:
        try:
            table_client.create_entity({
                "PartitionKey": PK_CODE,
                "RowKey": new_code,
                "CompetitionId": competition_id,
                "CreatedUtc": _now_utc(),
            })
        except ResourceExistsError:
            return None, _error("code_in_use", f"The competition code '{new_code}' is already in use.",
                                409, code=new_code)
        except Exception as e:
            logging.error(f"Error reserving competition code '{new_code}': {e}")
            return None, _error("internal_error", "Could not update the competition.", 500)
        updates["Code"] = new_code

    updates.update(extra_updates or {})
    updates["UpdatedUtc"] = _now_utc()

    conditional = {}
    if etag is not None:
        conditional = {"etag": etag, "match_condition": MatchConditions.IfNotModified}
    try:
        table_client.update_entity(
            {"PartitionKey": PK_COMPETITION, "RowKey": competition_id, **updates},
            mode=UpdateMode.MERGE,
            **conditional,
        )
    except ResourceModifiedError:
        if renaming:
            _delete_code_row(table_client, new_code)
        raise
    except Exception as e:
        logging.error(f"Error updating competition '{competition_id}': {e}")
        if renaming:
            _delete_code_row(table_client, new_code)
        return None, _error("internal_error", "Could not update the competition.", 500)

    if renaming:
        _delete_code_row(table_client, old_code)

    merged = dict(entity)
    merged.update(updates)
    return merged, None


def _update_competition(req: func.HttpRequest) -> func.HttpResponse:
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user

    competition_id = _route_competition_id(req)
    if not competition_id:
        return _competition_not_found()

    role, error = _require_access(user, competition_id, ROLE_WRITE)
    if error is not None:
        return error

    body = _read_body(req)
    if body is None:
        return _error("invalid_body", "Expected a JSON object body.", 400)

    table_client = get_table_client()
    if not table_client:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    try:
        entity = _get_competition_entity(table_client, competition_id)
    except Exception as e:
        logging.error(f"Error reading competition '{competition_id}': {e}")
        return _error("internal_error", "Could not read the competition.", 500)

    if entity is None or entity.get("Status") == STATUS_DELETED:
        return _error("not_found", "Competition not found.", 404)

    merged, error = _apply_competition_edit(table_client, entity, body)
    if error is not None:
        return error
    _audit_override(user, role, ROLE_WRITE, "competition.update", merged,
                    changes=_changes(entity, merged))
    return _json(_competition_json(merged, user, role))


def _soft_delete(table_client, entity):
    """Status=deleted, CODE row freed, DeletionDate pulled to the next midnight.
    Shared by the user DELETE, the admin DELETE and the admin purge.
    -> (merged entity, None) or (None, error response)."""
    competition_id = entity.get("RowKey", "")
    now = datetime.now(timezone.utc)
    next_midnight = _midnight(now) + timedelta(days=1)
    updates = {
        "Status": STATUS_DELETED,
        "DeleteReason": DELETE_REASON_USER,
        "DeletedUtc": _utc_text(now),
        "UpdatedUtc": _utc_text(now),
        # Only ever pulled forward — never later than the date already set.
        "DeletionDate": _utc_text(min(_effective_deletion_date(entity), next_midnight)),
    }

    try:
        table_client.update_entity(
            {"PartitionKey": PK_COMPETITION, "RowKey": competition_id, **updates},
            mode=UpdateMode.MERGE,
        )
    except Exception as e:
        logging.error(f"Error deleting competition '{competition_id}': {e}")
        return None, _error("internal_error", "Could not delete the competition.", 500)

    # Best-effort here: a CODE row left behind is released by the sweep.
    _release_code_row(table_client, entity.get("Code", ""), competition_id)

    merged = dict(entity)
    merged.update(updates)
    # Status=deleted reaches the tools now; they delete on their next run.
    _sync_clock(merged)
    return merged, None


def _delete_competition(req: func.HttpRequest) -> func.HttpResponse:
    """
    Soft delete now, purge tonight: the row drops out of the list and its CODE
    row is freed for reuse at once, and DeletionDate is pulled forward to the
    next midnight so the nightly sweep purges the data (and the tools follow)
    that same night. Who deleted it is NOT recorded — only that a user did.
    Owner only. The grants stay (a restore keeps its shares); the purge
    removes them.
    """
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user

    competition_id = _route_competition_id(req)
    if not competition_id:
        return _competition_not_found()

    role, error = _require_access(user, competition_id, ROLE_OWNER)
    if error is not None:
        return error

    table_client = get_table_client()
    if not table_client:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    try:
        entity = _get_competition_entity(table_client, competition_id)
    except Exception as e:
        logging.error(f"Error reading competition '{competition_id}': {e}")
        return _error("internal_error", "Could not read the competition.", 500)

    if entity is None:
        return _error("not_found", "Competition not found.", 404)

    if entity.get("Status") == STATUS_DELETED:
        # Idempotent: deleting twice is not an error.
        return _json(_competition_json(entity, user, role))

    merged, error = _soft_delete(table_client, entity)
    if error is not None:
        return error
    _audit_override(user, role, ROLE_OWNER, "competition.delete", merged,
                    changes=_changes(entity, merged))
    return _json(_competition_json(merged, user, role))


def _extend_competition(req: func.HttpRequest) -> func.HttpResponse:
    """
    POST /api/competitions/{id}/extend — push the deletion date out by
    EXTENSION_DAYS, counted from the current date or from today when that has
    already passed (an overdue row the sweep has not reached yet). No cap: the
    operator presses it once per extra week they need.

    Optimistic concurrency: the write only lands on the row version it was
    computed from, so two simultaneous presses add two weeks, not one. Who
    extended is deliberately not stored — only how often and when.
    """
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user

    competition_id = _route_competition_id(req)
    if not competition_id:
        return _competition_not_found()

    role, error = _require_access(user, competition_id, ROLE_WRITE)
    if error is not None:
        return error

    table_client = get_table_client()
    if not table_client:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    for attempt in range(EXTEND_RETRIES):
        try:
            entity = _get_competition_entity(table_client, competition_id)
        except Exception as e:
            logging.error(f"Error reading competition '{competition_id}': {e}")
            return _error("internal_error", "Could not read the competition.", 500)

        if entity is None or entity.get("Status") == STATUS_DELETED:
            return _error("not_found", "Competition not found.", 404)

        now = datetime.now(timezone.utc)
        base = max(_effective_deletion_date(entity), _midnight(now))
        updates = {
            "DeletionDate": _utc_text(base + timedelta(days=EXTENSION_DAYS)),
            "ExtendedCount": _int_column(entity, "ExtendedCount") + 1,
            "LastExtendedUtc": _utc_text(now),
            "UpdatedUtc": _utc_text(now),
        }
        try:
            table_client.update_entity(
                {"PartitionKey": PK_COMPETITION, "RowKey": competition_id, **updates},
                mode=UpdateMode.MERGE,
                etag=_entity_etag(entity),
                match_condition=MatchConditions.IfNotModified,
            )
        except ResourceModifiedError:
            logging.info(f"Competition '{competition_id}' changed during extend "
                         f"(attempt {attempt + 1}/{EXTEND_RETRIES}); retrying")
            continue
        except ResourceNotFoundError:
            return _error("not_found", "Competition not found.", 404)
        except Exception as e:
            logging.error(f"Error extending competition '{competition_id}': {e}")
            return _error("internal_error", "Could not extend the deletion date.", 500)

        merged = dict(entity)
        merged.update(updates)
        _sync_clock(merged)
        _audit_override(user, role, ROLE_WRITE, "competition.extend", merged,
                        changes=_changes(entity, merged))
        return _json(_competition_json(merged, user, role))

    return _error("conflict", "The competition kept changing; please try again.", 409)


# ── file pool handlers ────────────────────────────────────────────────────────
# competition-data/<guid>/uploads/<name> is name-keyed and overwritten in place:
# the same filename is the same logical file, which is what an FSM re-export of
# an already-uploaded PDF means. <guid>/fsm/ is written by the HOVTP listener
# (infra/hovtp/) and, on accept, by _attach_pending — never by these routes, so
# it is readable but not writable or deletable through them.

def _list_competition_files(req: func.HttpRequest) -> func.HttpResponse:
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user

    competition_id = _route_competition_id(req)
    if not competition_id:
        return _competition_not_found()

    _role, error = _require_access(user, competition_id, ROLE_READ)
    if error is not None:
        return error

    _entity, error = _load_competition(competition_id)
    if error is not None:
        return error

    container = _get_container_client()
    if container is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    files = []
    try:
        for source in (SOURCE_UPLOAD, SOURCE_FSM):
            prefix = _pool_prefix(competition_id, source)
            for blob in container.list_blobs(name_starts_with=prefix, include=["metadata"]):
                name = blob.name[len(prefix):]
                # Skip the prefix placeholder and anything nested deeper.
                if not name or "/" in name:
                    continue
                files.append(_file_info(name, source, blob))
    except Exception as e:
        logging.error(f"Error listing files for competition '{competition_id}': {e}")
        return _error("internal_error", "Could not list the competition files.", 500)

    files.sort(key=lambda info: (info["source"], info["name"].lower()))
    return _json({"files": files})


def _upload_competition_file(req: func.HttpRequest) -> func.HttpResponse:
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user

    competition_id = _route_competition_id(req)
    if not competition_id:
        return _competition_not_found()

    role, error = _require_access(user, competition_id, ROLE_WRITE)
    if error is not None:
        return error

    name, name_error = sanitize_pool_filename(req.params.get("filename"))
    if name_error == "unsupported_type":
        return _error("unsupported_type",
                      "Only PDF, XML and image files can be added to the competition files.", 400)
    if name_error:
        return _error("invalid_filename", "A usable filename is required.", 400)

    source_tool = _SOURCE_TOOL_STRIP_RE.sub("", str(req.params.get("sourceTool") or ""))
    source_tool = source_tool[:MAX_SOURCE_TOOL_LENGTH].lower()

    # Cheap pre-check: refuse an oversized upload from its declared length
    # before the body is materialised. The real check is on the bytes below.
    declared_length = req.headers.get("Content-Length") or req.headers.get("content-length")
    if declared_length:
        try:
            if int(declared_length) > POOL_MAX_FILE_SIZE:
                return _error("file_too_large", "Files are limited to 50 MB.", 413)
        except ValueError:
            pass

    entity, error = _load_competition(competition_id)
    if error is not None:
        return error
    if entity.get("Status") == STATUS_DELETED:
        return _error("competition_deleted", "This competition has been deleted.", 409)

    body = req.get_body() or b""
    if not body:
        return _error("empty_file", "The uploaded file is empty.", 400)
    if len(body) > POOL_MAX_FILE_SIZE:
        return _error("file_too_large", "Files are limited to 50 MB.", 413)

    container = _get_container_client()
    if container is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    content_type = _pool_content_type(name)
    try:
        container.upload_blob(
            name=_pool_prefix(competition_id, SOURCE_UPLOAD) + name,
            data=body,
            overwrite=True,
            metadata={
                "uploadedBy": _ascii_metadata(user.email),
                "sourceTool": source_tool,
                "origName": quote(str(req.params.get("filename") or ""), safe=""),
            },
            content_settings=ContentSettings(content_type=content_type),
        )
    except Exception as e:
        logging.error(f"Error uploading '{name}' for competition '{competition_id}': {e}")
        return _error("internal_error", "Could not store the file.", 500)

    _audit_override(user, role, ROLE_WRITE, "file.upload", entity,
                    changes={"file": [None, name]})

    return _json({
        "name": name,
        "source": SOURCE_UPLOAD,
        "size": len(body),
        "contentType": content_type,
        "uploadedUtc": _now_utc(),
        "uploadedBy": user.email,
        "sourceTool": source_tool,
    }, 201)


def _download_competition_file(req: func.HttpRequest) -> func.HttpResponse:
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user

    competition_id = _route_competition_id(req)
    if not competition_id:
        return _competition_not_found()

    _role, error = _require_access(user, competition_id, ROLE_READ)
    if error is not None:
        return error

    name = _route_file_name(req)
    if not name:
        return _error("invalid_filename", "A usable filename is required.", 400)

    source = _requested_source(req)
    if source is None:
        return _error("invalid_source", "The source must be 'upload' or 'fsm'.", 400)

    # Reads stay available on a soft-deleted competition; only writes don't.
    _entity, error = _load_competition(competition_id)
    if error is not None:
        return error

    container = _get_container_client()
    if container is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    try:
        blob_client = container.get_blob_client(_pool_prefix(competition_id, source) + name)
        if not blob_client.exists():
            return _error("file_not_found", "File not found.", 404)
        properties = blob_client.get_blob_properties()
        data = blob_client.download_blob().readall()
    except ResourceNotFoundError:
        return _error("file_not_found", "File not found.", 404)
    except Exception as e:
        logging.error(f"Error reading '{name}' for competition '{competition_id}': {e}")
        return _error("internal_error", "Could not read the file.", 500)

    content_settings = getattr(properties, "content_settings", None)
    content_type = getattr(content_settings, "content_type", None) or _pool_content_type(name)

    return func.HttpResponse(
        data,
        status_code=200,
        mimetype=content_type,
        headers={"Content-Disposition": f'inline; filename="{name}"'},
    )


def _delete_competition_file(req: func.HttpRequest) -> func.HttpResponse:
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user

    competition_id = _route_competition_id(req)
    if not competition_id:
        return _competition_not_found()

    role, error = _require_access(user, competition_id, ROLE_WRITE)
    if error is not None:
        return error

    name = _route_file_name(req)
    if not name:
        return _error("invalid_filename", "A usable filename is required.", 400)

    source = _requested_source(req)
    if source is None:
        return _error("invalid_source", "The source must be 'upload' or 'fsm'.", 400)
    if source == SOURCE_FSM:
        return _error("fsm_readonly", "Files delivered by the results system cannot be deleted.", 403)

    entity, error = _load_competition(competition_id)
    if error is not None:
        return error
    if entity.get("Status") == STATUS_DELETED:
        return _error("competition_deleted", "This competition has been deleted.", 409)

    container = _get_container_client()
    if container is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    try:
        blob_client = container.get_blob_client(_pool_prefix(competition_id, SOURCE_UPLOAD) + name)
        if not blob_client.exists():
            return _error("file_not_found", "File not found.", 404)
        blob_client.delete_blob()
    except ResourceNotFoundError:
        return _error("file_not_found", "File not found.", 404)
    except Exception as e:
        logging.error(f"Error deleting '{name}' from competition '{competition_id}': {e}")
        return _error("internal_error", "Could not delete the file.", 500)

    _audit_override(user, role, ROLE_WRITE, "file.delete", entity,
                    changes={"file": [name, None]})
    return _json({"status": "deleted", "name": name, "source": SOURCE_UPLOAD})


# ── HOVTP source handlers ─────────────────────────────────────────────────────

def _list_hovtp_sources(req: func.HttpRequest) -> func.HttpResponse:
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user

    competition_id = _route_competition_id(req)
    if not competition_id:
        return _competition_not_found()

    _role, error = _require_access(user, competition_id, ROLE_READ)
    if error is not None:
        return error

    _entity, error = _load_competition(competition_id)
    if error is not None:
        return error

    table_client = get_table_client()
    if not table_client:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    now = _now_utc()
    try:
        sources = [
            _source_to_json(entity, now)
            for entity in _list_hovtp_source_entities(table_client, competition_id)
        ]
    except Exception as e:
        logging.error(f"Error listing HOVTP sources for '{competition_id}': {e}")
        return _error("internal_error", "Could not list the data sources.", 500)

    # Newest first, but anything waiting for a decision floats to the top —
    # that is the one thing the operator has to act on.
    sources.sort(key=lambda source: source["lastSeenUtc"], reverse=True)
    sources.sort(key=lambda source: 0 if source["status"] in
                 (HOVTP_STATUS_PENDING, HOVTP_STATUS_EXPIRED) else 1)
    return _json({"sources": sources})


def _accept_hovtp_source(req: func.HttpRequest) -> func.HttpResponse:
    """Trust one sender for N days and attach everything it already sent."""
    target, error = _hovtp_request(req)
    if error is not None:
        return error
    competition_id, ip, user, role = target
    email = user.email

    body = _read_body(req)
    if body is None:
        return _error("invalid_body", "Expected a JSON object body.", 400)
    days = body.get("days")
    # `True` and `1.0` both compare equal to 1 in Python; neither is a window.
    if not isinstance(days, int) or isinstance(days, bool) or days not in HOVTP_ACCEPT_DAYS:
        return _error("invalid_days",
                      "Accept a data source for 1, 2, 3 or 7 days.", 400)

    entity, error = _load_competition(competition_id)
    if error is not None:
        return error
    if entity.get("Status") == STATUS_DELETED:
        return _error("competition_deleted", "This competition has been deleted.", 409)

    table_client = get_table_client()
    if not table_client:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    source = _load_hovtp_source(table_client, competition_id, ip)
    if source is None:
        return _error("source_not_found", "Unknown data source.", 404)

    now = _now_utc()
    accepted_until = (datetime.now(timezone.utc) + timedelta(days=days)) \
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    updates = {
        "Status": HOVTP_STATUS_ACCEPTED,
        "AcceptedUntilUtc": accepted_until,
        "AcceptedBy": email,
        "AcceptedUtc": now,
        "UpdatedUtc": now,
        # A re-accept must not keep looking rejected in the audit columns.
        "RejectedBy": "",
        "RejectedUtc": "",
    }
    try:
        _merge_hovtp_source(table_client, competition_id, ip, updates)
    except ResourceNotFoundError:
        return _error("source_not_found", "Unknown data source.", 404)
    except Exception as e:
        logging.error(f"Error accepting HOVTP source '{ip}' for '{competition_id}': {e}")
        return _error("internal_error", "Could not accept the data source.", 500)

    container = _get_container_client()
    if container is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    # The trust row is written first on purpose: from here on the listener puts
    # new files straight into the pool, and this pass only drains the backlog.
    attached, failed = _attach_pending(container, competition_id, ip, email)
    pending_count, pending_bytes = _pending_totals(container, competition_id, ip)
    counters = {"PendingCount": pending_count, "PendingBytes": pending_bytes,
                "UpdatedUtc": _now_utc()}
    try:
        _merge_hovtp_source(table_client, competition_id, ip, counters)
    except Exception as e:
        logging.warning(f"Could not update pending counters for '{ip}': {e}")

    merged = dict(source)
    merged.update(updates)
    merged.update(counters)
    _audit_override(user, role, ROLE_WRITE, "hovtp.accept", entity,
                    changes={"source": [source.get("Status") or None, HOVTP_STATUS_ACCEPTED]},
                    target=ip)
    return _json({
        "source": _source_to_json(merged, _now_utc()),
        "attached": attached,
        "failed": failed,
    })


def _deny_hovtp_source(req: func.HttpRequest) -> func.HttpResponse:
    """Reject (POST …/reject) and revoke (DELETE …/{ip}) are the same write.

    Both mean "stop trusting this IP and throw away what it is holding". They
    differ only in what came before: revoke follows an accept, so files that
    were already attached into the pool stay — only the quarantine is dropped.
    """
    target, error = _hovtp_request(req)
    if error is not None:
        return error
    competition_id, ip, user, role = target
    email = user.email

    entity, error = _load_competition(competition_id)
    if error is not None:
        return error
    if entity.get("Status") == STATUS_DELETED:
        return _error("competition_deleted", "This competition has been deleted.", 409)

    table_client = get_table_client()
    if not table_client:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    source = _load_hovtp_source(table_client, competition_id, ip)
    if source is None:
        return _error("source_not_found", "Unknown data source.", 404)

    container = _get_container_client()
    if container is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    now = _now_utc()
    updates = {
        "Status": HOVTP_STATUS_REJECTED,
        "RejectedBy": email,
        "RejectedUtc": now,
        "UpdatedUtc": now,
        "AcceptedUntilUtc": "",
        "PendingCount": 0,
        "PendingBytes": 0,
    }
    try:
        _merge_hovtp_source(table_client, competition_id, ip, updates)
    except ResourceNotFoundError:
        return _error("source_not_found", "Unknown data source.", 404)
    except Exception as e:
        logging.error(f"Error rejecting HOVTP source '{ip}' for '{competition_id}': {e}")
        return _error("internal_error", "Could not reject the data source.", 500)

    deleted = _delete_pending(container, competition_id, ip)
    _audit_override(user, role, ROLE_WRITE,
                    "hovtp.revoke" if req.method.upper() == "DELETE" else "hovtp.reject", entity,
                    changes={"source": [source.get("Status") or None, HOVTP_STATUS_REJECTED]},
                    target=ip)

    merged = dict(source)
    merged.update(updates)
    return _json({"source": _source_to_json(merged, _now_utc()), "deleted": deleted})


# ── access handlers ───────────────────────────────────────────────────────────
# Sharing: the owner (or an admin) grants read or write to users who have
# signed in at least once; a grantee may remove themselves ("leave"). The
# owner row itself is never touched here — only an admin moves it
# (PUT /api/manage/competitions/{id}/owner). Every change is audited.

def _route_user_id(req: func.HttpRequest, user: User) -> str:
    """{userId}: a GUID, or "me" for the caller. '' => 400."""
    raw = (req.route_params.get("userId") or "").strip().lower()
    if raw == ME:
        return user.user_id
    return raw if _GUID_RE.fullmatch(raw) else ""


def _access_target(req: func.HttpRequest, need: str):
    """Gate + {id} + access. -> ((user, competition_id, role, access client),
    None) or (None, error response)."""
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return None, user
    competition_id = _route_competition_id(req)
    if not competition_id:
        return None, _competition_not_found()
    role, error = _require_access(user, competition_id, need)
    if error is not None:
        return None, error
    access = get_table_client(_access_table_name())
    if access is None:
        return None, _error("storage_unavailable", "Storage configuration invalid.", 500)
    return (user, competition_id, role, access), None


def _list_access(req: func.HttpRequest) -> func.HttpResponse:
    target, error = _access_target(req, ROLE_OWNER)
    if error is not None:
        return error
    _user, competition_id, _role, access = target

    _entity, error = _load_competition(competition_id)
    if error is not None:
        return error
    try:
        return _json({"items": _access_list(competition_id, access)})
    except Exception as e:
        logging.error(f"Error listing the access of '{competition_id}': {e}")
        return _error("internal_error", "Could not list who has access.", 500)


def _set_access(req: func.HttpRequest) -> func.HttpResponse:
    """PUT …/access/{userId} {"role": "read"|"write"} — grant or change."""
    target, error = _access_target(req, ROLE_OWNER)
    if error is not None:
        return error
    user, competition_id, granted, access = target

    target_id = _route_user_id(req, user)
    if not target_id:
        return _error("invalid_user", "Unknown user.", 400)
    if target_id == user.user_id:
        return _error("cannot_target_self", "You cannot change your own access.", 400)

    body = _read_body(req)
    if body is None:
        return _error("invalid_body", "Expected a JSON object body.", 400)
    role = body.get("role")
    if role not in GRANTABLE_ROLES:
        return _error("invalid_role", "The role must be 'read' or 'write'.", 400)

    entity, error = _load_competition(competition_id)
    if error is not None:
        return error
    if entity.get("Status") == STATUS_DELETED:
        return _error("competition_deleted", "This competition has been deleted.", 409)

    target_row = _read_users([target_id]).get(target_id)
    if target_row is None:
        return _error("user_not_found", "Unknown user.", 404)

    key = {"PartitionKey": _access_pk(competition_id), "RowKey": target_id}
    for attempt in range(EXTEND_RETRIES):
        try:
            existing = access.get_entity(partition_key=key["PartitionKey"], row_key=target_id)
        except ResourceNotFoundError:
            existing = None
        except Exception as e:
            logging.error(f"Error reading the access of '{target_id}' to '{competition_id}': {e}")
            return _error("internal_error", "Could not change the access.", 500)

        before = existing.get("Role") if existing is not None else None
        if before == ROLE_OWNER:
            return _error("cannot_change_owner",
                          "The owner's access cannot be changed; an administrator can "
                          "transfer the ownership.", 400)
        if before == role:
            return _json({"item": _grant_json(target_id, role, target_row)})

        row = {**key, "Role": role, "GrantedBy": user.user_id, "GrantedUtc": _now_utc()}
        try:
            if existing is None:
                _create_row(access, row)
            else:
                # Conditional: an owner swap landing in between must not be
                # overwritten by a plain grant.
                access.update_entity(row, mode=UpdateMode.REPLACE, etag=_entity_etag(existing),
                                     match_condition=MatchConditions.IfNotModified)
        except (ResourceExistsError, ResourceModifiedError, ResourceNotFoundError):
            logging.info(f"Access of '{target_id}' to '{competition_id}' changed meanwhile "
                         f"(attempt {attempt + 1}/{EXTEND_RETRIES}); retrying")
            continue
        except Exception as e:
            logging.error(f"Error writing the access of '{target_id}' to '{competition_id}': {e}")
            return _error("internal_error", "Could not change the access.", 500)

        action = "access.grant" if before is None else "access.change"
        _audit(user.email, action, entity, {"role": [before, role]},
               target=target_row.get("Email") or "")
        _audit_override(user, granted, ROLE_OWNER, action, entity, {"role": [before, role]},
                        target=target_row.get("Email") or "")
        return _json({"item": _grant_json(target_id, role, target_row)})

    return _error("conflict", "The access kept changing; please try again.", 409)


def _remove_access(req: func.HttpRequest) -> func.HttpResponse:
    """DELETE …/access/{userId}: the owner or an admin revokes a grant; a
    grantee removing their own ("me" or their id) leaves. The owner row stays
    — ownership only moves through an admin."""
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user
    competition_id = _route_competition_id(req)
    if not competition_id:
        return _competition_not_found()

    # Any access at all, so a grantee can leave; no access -> 404 as usual.
    role, error = _require_access(user, competition_id, ROLE_READ)
    if error is not None:
        return error
    target_id = _route_user_id(req, user)
    if not target_id:
        return _error("invalid_user", "Unknown user.", 400)
    leaving = target_id == user.user_id
    if not leaving and role != ROLE_OWNER:
        return _error("owner_required", "Only the owner can do this.", 403)

    access = get_table_client(_access_table_name())
    if access is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)
    entity, error = _load_competition(competition_id)
    if error is not None:
        return error

    try:
        existing = access.get_entity(partition_key=_access_pk(competition_id), row_key=target_id)
    except ResourceNotFoundError:
        return _error("grant_not_found", "That user has no access to this competition.", 404)
    except Exception as e:
        logging.error(f"Error reading the access of '{target_id}' to '{competition_id}': {e}")
        return _error("internal_error", "Could not remove the access.", 500)
    before = existing.get("Role")
    if before == ROLE_OWNER:
        return _error("cannot_change_owner",
                      "The owner cannot be removed; an administrator can transfer the "
                      "ownership.", 400)

    try:
        access.delete_entity(partition_key=_access_pk(competition_id), row_key=target_id,
                             etag=_entity_etag(existing),
                             match_condition=MatchConditions.IfNotModified)
    except ResourceNotFoundError:
        pass
    except ResourceModifiedError:
        return _error("conflict", "The access changed meanwhile; please try again.", 409)
    except Exception as e:
        logging.error(f"Error removing the access of '{target_id}' to '{competition_id}': {e}")
        return _error("internal_error", "Could not remove the access.", 500)

    target_email = user.email if leaving else \
        (_read_users([target_id]).get(target_id) or {}).get("Email") or ""
    _audit(user.email, "access.leave" if leaving else "access.revoke", entity,
           {"role": [before, None]}, target=target_email)
    if not leaving:
        _audit_override(user, role, ROLE_OWNER, "access.revoke", entity,
                        {"role": [before, None]}, target=target_email)
    return _json({"status": "removed", "userId": target_id, "left": leaving})


# ── users handlers ────────────────────────────────────────────────────────────

# The rate limit lives in the users table so every instance shares it:
# PK SEARCHRATE / RK <userId>, a fixed per-minute and a fixed per-day window
# (start as epoch seconds + count), incremented etag-conditionally.

def _search_now() -> float:
    """Epoch seconds; a seam for the tests."""
    return time.time()


def _delete_search_rate_row(users, user_id: str) -> None:
    try:
        users.delete_entity(partition_key=PK_SEARCH_RATE, row_key=user_id)
    except ResourceNotFoundError:
        pass
    except Exception as e:
        logging.warning(f"Could not delete the search rate row of '{user_id}': {e}")


def _search_rate_limited(users, user_id: str) -> bool:
    """Count one search of `user_id`; True when it is over either limit (the
    search is then refused and not counted). Raises on a storage error or
    when the counter kept changing — the caller fails closed."""
    for _attempt in range(EXTEND_RETRIES):
        now = _search_now()
        try:
            row = users.get_entity(partition_key=PK_SEARCH_RATE, row_key=user_id)
        except ResourceNotFoundError:
            row = None
        minute_start = float((row or {}).get("MinuteStart") or 0)
        minute_count = int((row or {}).get("MinuteCount") or 0)
        day_start = float((row or {}).get("DayStart") or 0)
        day_count = int((row or {}).get("DayCount") or 0)
        if now - minute_start >= USER_SEARCH_RATE_WINDOW_SECONDS or now < minute_start:
            minute_start, minute_count = now, 0
        if now - day_start >= USER_SEARCH_DAY_WINDOW_SECONDS or now < day_start:
            day_start, day_count = now, 0
        if minute_count >= USER_SEARCH_RATE_LIMIT or day_count >= USER_SEARCH_DAILY_LIMIT:
            return True
        updated = {"PartitionKey": PK_SEARCH_RATE, "RowKey": user_id,
                   "MinuteStart": minute_start, "MinuteCount": minute_count + 1,
                   "DayStart": day_start, "DayCount": day_count + 1}
        try:
            if row is None:
                _create_row(users, updated)
            else:
                users.update_entity(updated, mode=UpdateMode.REPLACE, etag=_entity_etag(row),
                                    match_condition=MatchConditions.IfNotModified)
        except (ResourceExistsError, ResourceModifiedError, ResourceNotFoundError):
            continue   # a concurrent search of the same user counted first
        return False
    raise RuntimeError("search rate counter kept changing")


def _is_full_email(query: str) -> bool:
    """A complete address: printable ASCII, no spaces, exactly one '@' with
    something on both sides."""
    if not _PRINTABLE_ASCII_RE.fullmatch(query) or query.count("@") != 1:
        return False
    local, domain = query.split("@")
    return bool(local) and bool(domain)


def _email_hint(email: str) -> str:
    """'a•••@club.fi' — the first character of the local part and the domain."""
    local, sep, domain = (email or "").partition("@")
    if not sep or not local:
        return ""
    return f"{local[0]}\u2022\u2022\u2022@{domain}"


def _collaborator_ids(user_id: str, access) -> set:
    """Everyone who shares at least one competition with `user_id`, in either
    direction and with any role. Raises on a storage error."""
    found = set()
    for grant in _user_grant_rows(access, user_id):
        if grant.get("Role") not in ROLE_RANK:
            continue
        for row in _access_rows(access, grant.get("PartitionKey", "")):
            if row.get("Role") in ROLE_RANK:
                found.add(row.get("RowKey"))
    found.discard(user_id)
    return found


def _search_users(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/users/search?q= — the share dialog's type-ahead over people
    who have signed in, never yourself, at most USER_SEARCH_MAX_RESULTS:

      * q is a complete e-mail address -> the user with exactly that e-mail
        (ASCII case-insensitive), with their full e-mail;
      * otherwise (at least USER_SEARCH_MIN_CHARS) -> substring of the display
        NAME only, never of the e-mail. Hits carry `email: null` and only a
        masked `emailHint`, except people the caller already shares a
        competition with, who get their full e-mail.

    Item: {"userId", "name", "email": str | None, "emailHint": str}.
    Rate limited per user across instances: USER_SEARCH_RATE_LIMIT a minute,
    USER_SEARCH_DAILY_LIMIT a day -> 429 rate_limited."""
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user

    query = " ".join(str(req.params.get("q") or "").split())[:USER_SEARCH_MAX_QUERY]
    by_email = _is_full_email(query)
    if not by_email and len(query) < USER_SEARCH_MIN_CHARS:
        return _error("query_too_short",
                      f"Type at least {USER_SEARCH_MIN_CHARS} characters of a name, "
                      "or a full e-mail address.", 400)

    users = get_table_client(_users_table_name())
    access = get_table_client(_access_table_name())
    if users is None or access is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)
    try:
        if _search_rate_limited(users, user.user_id):
            return _error("rate_limited", "Too many searches; try again later.", 429)
    except Exception as e:
        logging.error(f"Could not count the search of '{user.user_id}': {e}")
        return _error("internal_error", "Could not search users.", 500)

    try:
        # Only USER rows: the same table holds the SEARCHRATE counters.
        rows = list(users.query_entities(f"PartitionKey eq '{PK_USER}'"))
    except ResourceNotFoundError:
        rows = []
    except Exception as e:
        logging.error(f"Error searching users: {e}")
        return _error("internal_error", "Could not search users.", 500)

    email_query = query.lower() if by_email else ""
    name_query = query.lower()
    hits = []
    for row in rows:
        user_id = row.get("RowKey") or ""
        if row.get("PartitionKey", PK_USER) != PK_USER or user_id == user.user_id:
            continue
        email = _normalize_email(row.get("Email"))
        name = (row.get("DisplayName") or "").lower()
        if by_email:
            if email and email == email_query:
                hits.append((0, name or email, user_id, row))
        elif name_query in name:
            hits.append((0 if name.startswith(name_query) else 1, name, user_id, row))
    hits.sort(key=lambda hit: hit[:3])
    hits = hits[:USER_SEARCH_MAX_RESULTS]

    if by_email or not hits:
        collaborators = set()
    else:
        try:
            collaborators = _collaborator_ids(user.user_id, access)
        except Exception as e:
            logging.error(f"Error reading the collaborators of '{user.user_id}': {e}")
            return _error("internal_error", "Could not search users.", 500)

    items = []
    for _rank, _key, user_id, row in hits:
        email = row.get("Email") or ""
        items.append({
            "userId": user_id,
            "name": row.get("DisplayName") or "",
            "email": (email or None) if (by_email or user_id in collaborators) else None,
            "emailHint": _email_hint(email),
        })
    return _json({"items": items})


def _recent_share_users(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/users/recent — the people the caller has shared their own
    competitions with, most recent grant first: the dialog's quick picks."""
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user
    access = get_table_client(_access_table_name())
    if access is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    latest = {}
    try:
        for grant in _user_grant_rows(access, user.user_id):
            if grant.get("Role") != ROLE_OWNER:
                continue
            for row in _access_rows(access, grant.get("PartitionKey", "")):
                grantee = row.get("RowKey") or ""
                if grantee == user.user_id or row.get("Role") not in GRANTABLE_ROLES:
                    continue
                granted = row.get("GrantedUtc") or ""
                if granted >= latest.get(grantee, ""):
                    latest[grantee] = granted
    except Exception as e:
        logging.error(f"Error listing recent share users of '{user.user_id}': {e}")
        return _error("internal_error", "Could not list recent users.", 500)

    ordered = sorted(latest, key=lambda grantee: (latest[grantee], grantee), reverse=True)
    found = _read_users(ordered[:RECENT_SHARE_USERS])
    return _json({"items": [_user_ref(grantee, found[grantee])
                            for grantee in ordered[:RECENT_SHARE_USERS] if grantee in found]})


def _current_user(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/users/me — the caller's platform user id (the share dialog
    needs it to tell "you" apart, and "Leave" may use it or "me")."""
    user = _require_user(req)
    if isinstance(user, func.HttpResponse):
        return user
    return _json({**_self_ref(user), "isAdmin": user.is_admin})


# ── retention sweep ───────────────────────────────────────────────────────────
# One clock: everything a competition owns on the platform — its pool blobs,
# FSM pushes and quarantine, its HOVTP trust rows and its e-mail addresses — is
# removed the night its DeletionDate passes. The tool Function Apps read the
# same row and delete their own linked records on the same schedule.

def _purge_enabled() -> bool:
    return (os.environ.get("RETENTION_PURGE_ENABLED") or "").strip().lower() in ("1", "true", "yes")


def _delete_competition_blobs(container, competition_id: str) -> tuple[int, bool]:
    """Delete every blob under `<guid>/`. -> (deleted, all succeeded).

    The trailing slash is the boundary: `<guid>` alone would also match a
    longer name that merely starts with the same characters.
    """
    prefix = f"{competition_id}/"
    deleted = 0
    ok = True
    try:
        names = [blob.name for blob in container.list_blobs(name_starts_with=prefix)]
    except Exception as e:
        logging.error(f"Retention: could not list blobs under '{prefix}': {e}")
        return 0, False
    for name in names:
        if not name.startswith(prefix):
            continue
        try:
            container.get_blob_client(name).delete_blob()
            deleted += 1
        except ResourceNotFoundError:
            pass
        except Exception as e:
            logging.error(f"Retention: could not delete blob '{name}': {e}")
            ok = False
    return deleted, ok


def _delete_hovtp_sources(table_client, competition_id: str) -> tuple[int, bool]:
    """Delete the competition's HOVTPSOURCE rows (IPs, acceptedBy e-mails)."""
    deleted = 0
    ok = True
    try:
        rows = list(_list_hovtp_source_entities(table_client, competition_id))
    except Exception as e:
        logging.error(f"Retention: could not list HOVTP sources of '{competition_id}': {e}")
        return 0, False
    for row in rows:
        try:
            table_client.delete_entity(partition_key=PK_HOVTP_SOURCE, row_key=row["RowKey"])
            deleted += 1
        except ResourceNotFoundError:
            pass
        except Exception as e:
            logging.error(f"Retention: could not delete HOVTP source '{row.get('RowKey')}': {e}")
            ok = False
    return deleted, ok


def _delete_competition_access(competition_id: str) -> tuple[int, bool]:
    """Delete the competition's competitionaccess rows (owner and grants)."""
    access = get_table_client(_access_table_name())
    if access is None:
        logging.error("Retention: access table unavailable")
        return 0, False
    deleted = 0
    ok = True
    try:
        rows = _access_rows(access, competition_id)
    except Exception as e:
        logging.error(f"Retention: could not list the access rows of '{competition_id}': {e}")
        return 0, False
    for row in rows:
        try:
            access.delete_entity(partition_key=row["PartitionKey"], row_key=row["RowKey"])
            deleted += 1
        except ResourceNotFoundError:
            pass
        except Exception as e:
            logging.error(f"Retention: could not delete access row '{row.get('RowKey')}' "
                          f"of '{competition_id}': {e}")
            ok = False
    return deleted, ok


def _tombstone(entity, now_text: str) -> dict:
    """What survives a purge: the competition's identity and timeline, no
    personal data (no CreatedBy/DeletedBy/any e-mail)."""
    stone = {"PartitionKey": PK_COMPETITION, "RowKey": entity["RowKey"]}
    for column in TOMBSTONE_COLUMNS:
        if column in entity and entity.get(column) is not None:
            stone[column] = entity.get(column)
    stone["Status"] = STATUS_DELETED
    stone["UpdatedUtc"] = now_text
    stone["PurgedUtc"] = now_text
    return stone


def _purge_competition(table_client, container, entity, now: datetime) -> bool:
    """Purge one expired competition. -> True once the tombstone is written.

    Every step is idempotent, and the tombstone (PurgedUtc) is written last:
    if any step fails the row stays un-purged and the next night retries all
    of them.
    """
    competition_id = entity["RowKey"]
    now_text = _utc_text(now)

    # 1. Claim the purge before anything destructive, in one conditional
    #    write: deleted (so the HOVTP listener answers 451 and the API 404s an
    #    extend from here on) and PurgingUtc, after which an admin restore
    #    refuses. Conditional even when already deleted: an extend or a
    #    restore that just landed wins and the row is reconsidered tomorrow.
    updates = {"PurgingUtc": entity.get("PurgingUtc") or now_text, "UpdatedUtc": now_text}
    newly_deleted = entity.get("Status") != STATUS_DELETED
    if newly_deleted:
        updates.update({
            "Status": STATUS_DELETED,
            "DeletedUtc": entity.get("DeletedUtc") or now_text,
            "DeleteReason": entity.get("DeleteReason") or AUTO_CLEANUP_ACTOR,
        })
    try:
        table_client.update_entity(
            {"PartitionKey": PK_COMPETITION, "RowKey": competition_id, **updates},
            mode=UpdateMode.MERGE,
            etag=_entity_etag(entity),
            match_condition=MatchConditions.IfNotModified,
        )
    except ResourceModifiedError:
        logging.info(f"Retention: '{competition_id}' changed during the sweep; "
                     "reconsidered next night")
        return False
    except Exception as e:
        logging.error(f"Retention: could not claim the purge of '{competition_id}': {e}")
        return False
    if newly_deleted:
        _sync_clock({**entity, **updates})

    code_ok = _release_code_row(table_client, entity.get("Code", ""), competition_id)
    _sources, sources_ok = _delete_hovtp_sources(table_client, competition_id)
    # Grants go with the data: a purged competition has nobody to share with.
    _grants, access_ok = _delete_competition_access(competition_id)
    if container is None:
        blobs, blobs_ok = 0, False
    else:
        blobs, blobs_ok = _delete_competition_blobs(container, competition_id)
    if not (code_ok and sources_ok and access_ok and blobs_ok):
        logging.error(f"Retention: purge of '{competition_id}' incomplete; retried next night")
        return False

    # 2. Tombstone — replace (not merge), so no e-mail column can survive.
    #    A code rename that was already in flight when the row was marked
    #    deleted can have claimed a NEW CODE row since step 1 released the old
    #    one: release whatever code the row holds now, and replace only that
    #    exact version — a later change fails the ETag and the next night
    #    retries the whole purge.
    try:
        fresh = table_client.get_entity(partition_key=PK_COMPETITION, row_key=competition_id)
        if fresh.get("Status") != STATUS_DELETED or not fresh.get("PurgingUtc"):
            # Cannot happen while restore honours PurgingUtc; never tombstone
            # a row that is not (still) ours to purge.
            logging.error(f"Retention: '{competition_id}' is no longer claimed for purging; "
                          "tombstone not written")
            return False
        if not _release_code_row(table_client, fresh.get("Code", ""), competition_id):
            logging.error(f"Retention: could not release the code of '{competition_id}'; "
                          "retried next night")
            return False
        stone = _tombstone(fresh, now_text)
        table_client.update_entity(
            stone,
            mode=UpdateMode.REPLACE,
            etag=_entity_etag(fresh),
            match_condition=MatchConditions.IfNotModified,
        )
    except Exception as e:
        logging.error(f"Retention: could not write the tombstone of '{competition_id}': {e}")
        return False

    # The tools' verdict: Status=deleted + PurgedUtc. A failed write here is
    # caught by the reconcile at the end of this same sweep.
    _sync_clock(stone)

    logging.info(f"Retention: purged competition '{competition_id}' "
                 f"(code '{entity.get('Code', '')}', {blobs} blob(s))")
    return True


def _competition_is_live(table_client, competition_id: str) -> bool:
    """Exists and not purged (a soft-deleted one still counts: it is purged
    within a day, and the user goes the night after). Unreadable = live."""
    try:
        entity = _get_competition_entity(table_client, competition_id)
    except Exception:
        return True
    return entity is not None and not entity.get("PurgedUtc")


def _sweep_inactive_users(now: datetime, purge_enabled: bool, summary: dict) -> None:
    """Sweep step 7: a users row unseen for INACTIVE_USER_DAYS whose user owns
    no live competition loses its grants, its identity links and then the
    row itself (last, so a failed step retries tomorrow). Obeys the kill
    switch: dry-run only counts."""
    table_client = get_table_client()
    users = get_table_client(_users_table_name())
    identities = get_table_client(_user_identities_table_name())
    access = get_table_client(_access_table_name())
    if None in (table_client, users, identities, access):
        logging.error("Retention: user tables unavailable; inactive-user sweep skipped")
        return
    try:
        rows = list(users.query_entities(f"PartitionKey eq '{PK_USER}'"))
    except ResourceNotFoundError:
        return
    except Exception as e:
        logging.error(f"Retention: could not list users: {e}")
        return

    cutoff = now - timedelta(days=INACTIVE_USER_DAYS)
    for row in rows:
        user_id = row.get("RowKey") or ""
        if not _GUID_RE.fullmatch(user_id):
            continue
        last = _parse_utc(row.get("LastSeenUtc")) or _parse_utc(row.get("FirstSeenUtc"))
        if last is None or last >= cutoff:
            continue
        try:
            grants = _user_grant_rows(access, user_id)
            links = list(identities.query_entities(
                f"PartitionKey eq '{PK_IDENTITY}' and UserId eq '{user_id}'"))
        except Exception as e:
            logging.error(f"Retention: could not read the grants of user '{user_id}': {e}")
            continue
        if any(grant.get("Role") == ROLE_OWNER
               and _competition_is_live(table_client, grant.get("PartitionKey", ""))
               for grant in grants):
            continue
        if not purge_enabled:
            logging.warning(f"Retention (dry-run): would remove inactive user '{user_id}'")
            summary["users_would_delete"] += 1
            continue

        # Re-read right before deleting anything: a user who signed in since
        # the scan is active again and keeps everything. The row's etag then
        # guards the final delete against a sign-in during the steps below.
        try:
            fresh = users.get_entity(partition_key=PK_USER, row_key=user_id)
        except ResourceNotFoundError:
            continue
        except Exception as e:
            logging.error(f"Retention: could not re-read users row '{user_id}': {e}")
            continue
        last = _parse_utc(fresh.get("LastSeenUtc")) or _parse_utc(fresh.get("FirstSeenUtc"))
        if last is None or last >= cutoff:
            continue

        ok = True
        for partition_key, row_key, client in (
                [(g["PartitionKey"], g["RowKey"], access) for g in grants]
                + [(link["PartitionKey"], link["RowKey"], identities) for link in links]):
            try:
                client.delete_entity(partition_key=partition_key, row_key=row_key)
            except ResourceNotFoundError:
                pass
            except Exception as e:
                logging.error(f"Retention: could not delete '{partition_key}/{row_key}' "
                              f"of user '{user_id}': {e}")
                ok = False
        if not ok:
            continue
        try:
            users.delete_entity(partition_key=PK_USER, row_key=user_id,
                                etag=_entity_etag(fresh),
                                match_condition=MatchConditions.IfNotModified)
        except ResourceNotFoundError:
            pass
        except ResourceModifiedError:
            logging.warning(f"Retention: user '{user_id}' was seen during the sweep; "
                            "users row kept")
            continue
        except Exception as e:
            logging.error(f"Retention: could not delete users row '{user_id}': {e}")
            continue
        _delete_search_rate_row(users, user_id)
        _LAST_SEEN_WRITES.pop(user_id, None)
        summary["users_deleted"] += 1


def _session_last_activity(entity) -> datetime | None:
    for column in ("UpdatedUtc", "CreatedUtc"):
        moment = _parse_utc(entity.get(column))
        if moment is not None:
            return moment
    metadata = getattr(entity, "metadata", None) or {}
    return _parse_utc(metadata.get("timestamp"))


def _run_retention_sweep(now: datetime, purge_enabled: bool, *,
                         dry_run_manual: bool = False) -> dict:
    """The nightly retention pass. Returns counters (logged, recorded as a
    SWEEP row in the admin log, and asserted on by the tests). With purge
    disabled it still backfills DeletionDate but deletes nothing — it only
    logs what it would have purged. `dry_run_manual` marks the admin panel's
    "dry-run now" in that record; it never enables purging by itself."""
    summary = _sweep_registry(now, purge_enabled)
    # 6. The admin log keeps its own retention (AUDIT_RETENTION_DAYS /
    #    SWEEP_LOG_RETENTION_DAYS), under the same kill switch.
    _prune_admin_log(now, purge_enabled, summary)
    # 7. The user directory: inactive users who own nothing live.
    _sweep_inactive_users(now, purge_enabled, summary)
    logging.info(f"Retention sweep ({'purge' if purge_enabled else 'dry-run'}): {summary}")
    _record_sweep(now, purge_enabled, summary, dry_run_manual)
    return summary


def _sweep_registry(now: datetime, purge_enabled: bool) -> dict:
    """Steps 1–5 of the sweep (see the module docstring)."""
    summary = {"backfilled": 0, "purged": 0, "would_purge": 0, "failed": 0,
               "resweeps": 0, "sessions_deleted": 0, "sessions_would_delete": 0,
               "clock_synced": 0, "audit_pruned": 0, "audit_would_prune": 0,
               "sweeps_pruned": 0, "sweeps_would_prune": 0,
               "users_deleted": 0, "users_would_delete": 0}

    table_client = get_table_client()
    if not table_client:
        logging.error("Retention: storage configuration invalid; sweep skipped")
        return summary
    container = _get_container_client()
    if container is None and purge_enabled:
        logging.error("Retention: blob storage unavailable; purges will be retried")

    try:
        entities = list(table_client.query_entities(f"PartitionKey eq '{PK_COMPETITION}'"))
    except Exception as e:
        logging.error(f"Retention: could not list competitions: {e}")
        return summary

    resweep_after = now - timedelta(days=RESWEEP_DAYS)

    for entity in entities:
        competition_id = entity.get("RowKey", "")
        if not competition_id:
            continue

        # 1. Backfill — also in dry-run, so the date the UI shows is the one
        #    that will apply.
        if not _parse_utc(entity.get("DeletionDate")):
            deletion = _utc_text(_effective_deletion_date(entity))
            try:
                table_client.update_entity(
                    {"PartitionKey": PK_COMPETITION, "RowKey": competition_id,
                     "DeletionDate": deletion},
                    mode=UpdateMode.MERGE,
                    etag=_entity_etag(entity),
                    match_condition=MatchConditions.IfNotModified,
                )
                entity = table_client.get_entity(
                    partition_key=PK_COMPETITION, row_key=competition_id)
                summary["backfilled"] += 1
                _sync_clock(entity)
            except ResourceModifiedError:
                # Someone (an extend) wrote the row meanwhile; tomorrow's run sees it.
                continue
            except Exception as e:
                logging.error(f"Retention: could not backfill '{competition_id}': {e}")
                continue

        purged_utc = _parse_utc(entity.get("PurgedUtc"))
        if purged_utc is not None:
            # 3. Re-sweep a fresh tombstone's prefix for late HOVTP writes.
            if purged_utc >= resweep_after and purge_enabled and container is not None:
                _delete_competition_blobs(container, competition_id)
                _delete_hovtp_sources(table_client, competition_id)
                _delete_competition_access(competition_id)
                summary["resweeps"] += 1
            continue

        if _effective_deletion_date(entity) > now:
            continue

        # 2. Expired.
        if not purge_enabled:
            logging.warning(f"Retention (dry-run): would purge competition '{competition_id}' "
                            f"(code '{entity.get('Code', '')}', deletion date "
                            f"{_utc_text(_effective_deletion_date(entity))})")
            summary["would_purge"] += 1
            continue
        if _purge_competition(table_client, container, entity, now):
            summary["purged"] += 1
        else:
            summary["failed"] += 1

    # 4. HOVTP sessions belong to no competition; drop the idle ones.
    idle_before = now - timedelta(days=HOVTP_SESSION_IDLE_DAYS)
    try:
        sessions = list(table_client.query_entities(f"PartitionKey eq '{PK_HOVTP_SESSION}'"))
    except Exception as e:
        logging.error(f"Retention: could not list HOVTP sessions: {e}")
        sessions = []
    for session in sessions:
        last = _session_last_activity(session)
        if last is None or last >= idle_before:
            continue
        if not purge_enabled:
            summary["sessions_would_delete"] += 1
            continue
        try:
            table_client.delete_entity(partition_key=PK_HOVTP_SESSION, row_key=session["RowKey"])
            summary["sessions_deleted"] += 1
        except ResourceNotFoundError:
            pass
        except Exception as e:
            logging.error(f"Retention: could not delete HOVTP session '{session.get('RowKey')}': {e}")

    # 5. The clock table follows the registry — self-healing for any missed
    #    write (also in dry-run: it only mirrors state, it deletes nothing).
    clock_client = get_table_client(_clock_table_name())
    if clock_client is None:
        logging.error("Retention: clock table unavailable; reconcile skipped")
    else:
        summary["clock_synced"], _ok = _reconcile_clock(table_client, clock_client)

    return summary


# ── admin: gate ───────────────────────────────────────────────────────────────
# The router already answers 403 on /api/manage/* for non-admins, but this
# app's hostname is public, so the gate is checked again here. Same
# fail-closed checks as _require_user (secret, forwarded tid/oid, allowed
# tenant), then X-Forwarded-User-Admin: 1 — which the router sends only for
# identities carrying the admin app role (Site.Admin) and strips from client
# requests; the proxy secret is what makes that header trustworthy, exactly as
# for the tool backends. It reads no table: the admin routes need no users row.

def _forwarded_admin(req: func.HttpRequest) -> bool:
    """The router's admin verdict. Only meaningful after the secret check."""
    return _header(req, "X-Forwarded-User-Admin").strip() == "1"


def _require_admin(req: func.HttpRequest):
    """-> the admin's audit name (lowercased e-mail, or `<tid>_<oid>` when the
    identity has no usable e-mail), or the 401/403 response to return."""
    if not _proxy_secret_ok(req):
        logging.warning("Admin route: proxy shared secret unset, missing or mismatched")
        return _error("unauthorized", "Sign-in required.", 401)

    identity = _forwarded_identity(req)
    if identity is None:
        return _error("unauthorized", "Sign-in required.", 401)
    tid, oid, email, _name = identity
    if tid not in _allowed_tenant_ids():
        return _error("tenant_not_allowed", "Accounts of your organisation cannot use this site.", 403)
    if not _forwarded_admin(req):
        return _error("admin_required", "Administrator access required.", 403)
    return email or _identity_row_key(tid, oid)


# ── admin: log (audit trail + sweep runs) ─────────────────────────────────────
# Best effort, like _sync_clock: the admin action has already succeeded when
# its audit row is written, so a failed write is logged at ERROR and the
# action stands.

def _admin_log_table_name() -> str:
    return os.environ.get("ADMIN_LOG_TABLE") or ADMIN_LOG_TABLE_DEFAULT


def _inverted_ticks(moment: datetime) -> str:
    """Fixed-width, so ascending RowKey order is newest first."""
    delta = moment.astimezone(timezone.utc) - _TICKS_EPOCH
    ticks = (delta.days * 86400 + delta.seconds) * 10_000_000 + delta.microseconds * 10
    return f"{_MAX_TICKS - ticks:019d}"


def _admin_log_key(moment: datetime) -> str:
    # The uuid keeps two writes within the same 100 ns tick apart.
    return f"{_inverted_ticks(moment)}_{uuid4().hex}"


def _write_admin_log(row: dict) -> bool:
    try:
        client = get_table_client(_admin_log_table_name())
        if client is None:
            logging.error(f"Admin log unavailable; {row.get('PartitionKey')} row not written")
            return False
        try:
            client.create_entity(row)
        except ResourceNotFoundError:
            # Table missing (local dev); Bicep creates it in Azure.
            _ensure_table(client)
            client.create_entity(row)
        return True
    except Exception as e:
        logging.error(f"Could not write the admin log ({row.get('PartitionKey')} "
                      f"{row.get('Action', '')}): {e}")
        return False


def _audit(actor: str, action: str, entity=None, changes=None, outcome: str = "ok",
           target: str = "") -> bool:
    """One AUDIT row. `changes` is {field: [before, after]}, changed fields
    only; `target` is the e-mail of the user an access change is about."""
    now = datetime.now(timezone.utc)
    entity = entity or {}
    return _write_admin_log({
        "PartitionKey": PK_AUDIT,
        "RowKey": _admin_log_key(now),
        "Utc": _utc_text(now),
        "Actor": actor,
        "Action": action,
        "CompetitionId": entity.get("RowKey") or "",
        "CompetitionCode": entity.get("Code") or "",
        "Target": target or "",
        "Changes": json.dumps(changes or {}),
        "Outcome": outcome,
    })


def _record_sweep(now: datetime, purge_enabled: bool, summary: dict, dry_run_manual: bool) -> bool:
    """One SWEEP row per _run_retention_sweep — the diagnostics' "last runs"."""
    return _write_admin_log({
        "PartitionKey": PK_SWEEP,
        "RowKey": _admin_log_key(now),
        "Utc": _utc_text(now),
        "PurgeEnabled": bool(purge_enabled),
        "DryRunManual": bool(dry_run_manual),
        "Summary": json.dumps(summary),
    })


def _prune_admin_log(now: datetime, purge_enabled: bool, summary: dict) -> None:
    """Sweep step 6: AUDIT rows older than AUDIT_RETENTION_DAYS and SWEEP rows
    older than SWEEP_LOG_RETENTION_DAYS. Older = larger inverted ticks, so each
    is one RowKey range from the cut-off up."""
    client = get_table_client(_admin_log_table_name())
    if client is None:
        logging.error("Retention: admin log unavailable; prune skipped")
        return
    for partition_key, days, done, would in (
        (PK_AUDIT, AUDIT_RETENTION_DAYS, "audit_pruned", "audit_would_prune"),
        (PK_SWEEP, SWEEP_LOG_RETENTION_DAYS, "sweeps_pruned", "sweeps_would_prune"),
    ):
        cutoff = _inverted_ticks(now - timedelta(days=days))
        try:
            rows = list(client.query_entities(
                f"PartitionKey eq '{partition_key}' and RowKey ge '{cutoff}'"))
        except ResourceNotFoundError:
            continue   # no admin log yet
        except Exception as e:
            logging.error(f"Retention: could not list old {partition_key} rows: {e}")
            continue
        for row in rows:
            if not purge_enabled:
                summary[would] += 1
                continue
            try:
                client.delete_entity(partition_key=partition_key, row_key=row["RowKey"])
                summary[done] += 1
            except ResourceNotFoundError:
                pass
            except Exception as e:
                logging.error(f"Retention: could not delete {partition_key} row "
                              f"'{row.get('RowKey')}': {e}")


def _audit_to_json(row) -> dict:
    try:
        changes = json.loads(row.get("Changes") or "{}")
    except ValueError:
        changes = {}
    return {
        "id": row.get("RowKey", ""),
        "utc": row.get("Utc", ""),
        "actor": row.get("Actor", ""),
        "action": row.get("Action", ""),
        "competitionId": row.get("CompetitionId") or None,
        "competitionCode": row.get("CompetitionCode") or None,
        "target": row.get("Target") or None,
        "changes": changes if isinstance(changes, dict) else {},
        "outcome": row.get("Outcome", ""),
    }


def _sweep_to_json(row) -> dict:
    try:
        summary = json.loads(row.get("Summary") or "{}")
    except ValueError:
        summary = {}
    return {
        "utc": row.get("Utc", ""),
        "purgeEnabled": bool(row.get("PurgeEnabled")),
        "dryRunManual": bool(row.get("DryRunManual")),
        "summary": summary,
    }


# ── admin: wire shape ─────────────────────────────────────────────────────────

# The fields an AUDIT row's `changes` may name, in AdminCompetition terms.
AUDIT_FIELDS = ("name", "code", "startDate", "endDate", "venue", "createdBy",
                "deletionDate", "status")


def _admin_status(entity) -> str:
    if entity.get("PurgedUtc"):
        return STATUS_PURGED
    return entity.get("Status") or STATUS_ACTIVE


def _clock_to_json(entity, clock_row):
    if clock_row is None:
        return None
    return {
        "inSync": not _clock_differs(_clock_row(entity), clock_row),
        "deletionDate": clock_row.get("DeletionDate") or None,
        "status": clock_row.get("Status") or None,
        "purgedUtc": clock_row.get("PurgedUtc") or None,
    }


def entity_to_admin_competition(entity, clock_row=None) -> dict:
    """entity_to_competition + the server-owned columns an admin may see."""
    competition = entity_to_competition(entity)
    competition.update({
        "startDate": competition["date"],
        "endDate": competition["endDate"] or None,
        "createdBy": competition["createdBy"] or None,
        "status": _admin_status(entity),
        "extendedCount": _int_column(entity, "ExtendedCount"),
        "lastExtendedUtc": entity.get("LastExtendedUtc") or None,
        "deleteReason": entity.get("DeleteReason") or None,
        "deletedUtc": entity.get("DeletedUtc") or None,
        "purgedUtc": entity.get("PurgedUtc") or None,
        "clock": _clock_to_json(entity, clock_row),
    })
    return competition


def _changes(before, after) -> dict:
    old = entity_to_admin_competition(before)
    new = entity_to_admin_competition(after)
    return {field: [old[field], new[field]] for field in AUDIT_FIELDS if old[field] != new[field]}


def _read_clock_row(competition_id: str):
    """The competition's clock row, or None (missing or unreadable)."""
    try:
        client = get_table_client(_clock_table_name())
        if client is None:
            return None
        return client.get_entity(partition_key=PK_COMPETITION,
                                 row_key=str(competition_id).strip().lower())
    except ResourceNotFoundError:
        return None
    except Exception as e:
        logging.warning(f"Could not read the clock row of '{competition_id}': {e}")
        return None


def _read_clock_rows():
    """-> ({rowkey: clock row}, None) or ({}, error text)."""
    try:
        client = get_table_client(_clock_table_name())
        if client is None:
            return {}, "Clock table configuration invalid."
        rows = client.query_entities(f"PartitionKey eq '{PK_COMPETITION}'")
        return {row.get("RowKey"): row for row in rows}, None
    except ResourceNotFoundError:
        return {}, None
    except Exception as e:
        logging.warning(f"Could not read the clock table: {e}")
        return {}, _short_error(e)


def _short_error(error: Exception) -> str:
    return f"{type(error).__name__}: {str(error)[:200]}"


def _parse_deletion_date(value, now: datetime) -> datetime | None:
    """'YYYY-MM-DD' or 'YYYY-MM-DDT00:00:00Z', on or after tomorrow 00:00 UTC.
    Any later date is allowed. None => invalid."""
    if not isinstance(value, str) or not _DELETION_DATE_RE.match(value.strip()):
        return None
    day = value.strip()[:10]
    if not _valid_date(day):
        return None
    moment = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    if moment < _midnight(now) + timedelta(days=1):
        return None
    return moment


def _admin_target(req: func.HttpRequest):
    """Gate + {id} + table client, shared by the per-competition admin routes.

    -> ((admin, competition_id, table_client), None) or (None, error response).
    """
    admin = _require_admin(req)
    if isinstance(admin, func.HttpResponse):
        return None, admin

    competition_id = _route_competition_id(req)
    if not competition_id:
        return None, _competition_not_found()

    table_client = get_table_client()
    if not table_client:
        return None, _error("storage_unavailable", "Storage configuration invalid.", 500)

    return (admin, competition_id, table_client), None


def _read_admin_entity(table_client, competition_id: str):
    """(entity, None) or (None, 404/500 response)."""
    try:
        entity = _get_competition_entity(table_client, competition_id)
    except Exception as e:
        logging.error(f"Error reading competition '{competition_id}': {e}")
        return None, _error("internal_error", "Could not read the competition.", 500)
    if entity is None:
        return None, _error("not_found", "Competition not found.", 404)
    return entity, None


def _admin_competition_response(entity) -> func.HttpResponse:
    return _json({"competition": entity_to_admin_competition(
        entity, _read_clock_row(entity.get("RowKey", "")))})


# ── admin: handlers ───────────────────────────────────────────────────────────

def _admin_list_competitions(req: func.HttpRequest) -> func.HttpResponse:
    admin = _require_admin(req)
    if isinstance(admin, func.HttpResponse):
        return admin

    status = (req.params.get("status") or "all").strip().lower()
    if status not in ADMIN_STATUS_FILTERS:
        return _error("invalid_status", "Status must be active, deleted, purged or all.", 400)

    table_client = get_table_client()
    if not table_client:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    try:
        entities = list(table_client.query_entities(f"PartitionKey eq '{PK_COMPETITION}'"))
    except ResourceNotFoundError:
        entities = []
    except Exception as e:
        logging.error(f"Error listing competitions for the admin panel: {e}")
        return _error("internal_error", "Could not list competitions.", 500)

    clocks, _clock_error = _read_clock_rows()
    owners = _all_owner_refs()
    competitions = []
    for entity in entities:
        if status != "all" and _admin_status(entity) != status:
            continue
        competition = entity_to_admin_competition(
            entity, clocks.get(str(entity.get("RowKey") or "").lower()))
        competition["owner"] = owners.get(_access_pk(entity.get("RowKey", "")))
        competitions.append(competition)
    competitions.sort(key=_sort_key, reverse=True)
    return _json({"competitions": competitions})


def _all_owner_refs() -> dict:
    """{competition guid: owner UserRef} for every competition with an owner —
    two scans (owner rows, users) instead of one lookup per row. Best effort:
    {} when the tables cannot be read."""
    access = get_table_client(_access_table_name())
    users = get_table_client(_users_table_name())
    if access is None or users is None:
        return {}
    try:
        owner_rows = list(access.query_entities(f"Role eq '{ROLE_OWNER}'"))
        names = {row.get("RowKey"): row for row in users.query_entities(f"PartitionKey eq '{PK_USER}'")}
    except ResourceNotFoundError:
        return {}
    except Exception as e:
        logging.warning(f"Could not read the competition owners: {e}")
        return {}
    owners = {}
    for row in sorted(owner_rows, key=lambda r: r.get("GrantedUtc") or ""):
        owners[row.get("PartitionKey")] = _user_ref(row.get("RowKey"), names.get(row.get("RowKey")))
    return owners


def _admin_get_competition(req: func.HttpRequest) -> func.HttpResponse:
    target, error = _admin_target(req)
    if error is not None:
        return error
    _admin, competition_id, table_client = target

    entity, error = _read_admin_entity(table_client, competition_id)
    if error is not None:
        return error

    container = _get_container_client()
    if container is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    files = {"count": 0, "bytes": 0}
    hovtp = {HOVTP_STATUS_PENDING: 0, HOVTP_STATUS_ACCEPTED: 0,
             HOVTP_STATUS_EXPIRED: 0, HOVTP_STATUS_REJECTED: 0}
    now = _now_utc()
    try:
        # Everything under <guid>/ — uploads, fsm and the quarantine alike.
        for blob in container.list_blobs(name_starts_with=f"{competition_id}/"):
            files["count"] += 1
            files["bytes"] += getattr(blob, "size", 0) or 0
        for source in _list_hovtp_source_entities(table_client, competition_id):
            status = _source_status(source, now)
            hovtp[status] = hovtp.get(status, 0) + 1
    except Exception as e:
        logging.error(f"Error reading the details of competition '{competition_id}': {e}")
        return _error("internal_error", "Could not read the competition details.", 500)

    try:
        access = _access_list(competition_id)
    except Exception as e:
        logging.error(f"Error reading the access list of '{competition_id}': {e}")
        return _error("internal_error", "Could not read the competition details.", 500)

    return _json({
        "competition": entity_to_admin_competition(entity, _read_clock_row(competition_id)),
        "files": files,
        "hovtp": hovtp,
        "access": access,
    })


def _admin_update_competition(req: func.HttpRequest) -> func.HttpResponse:
    """The user PATCH (same validation, same CODE-row move) plus the deletion
    date — any day from tomorrow on, synced into the clock table at once.
    `createdBy` is read-only history now (400): the owner is the
    competitionaccess owner row, moved by PUT …/owner. Etag-conditional with
    retries, so the audit row's "before" is the version the write replaced."""
    target, error = _admin_target(req)
    if error is not None:
        return error
    admin, competition_id, table_client = target

    body = _read_body(req)
    if body is None:
        return _error("invalid_body", "Expected a JSON object body.", 400)

    extra = {}
    if "createdBy" in body:
        return _error("created_by_read_only",
                      "Created by is history; change the owner instead.", 400)

    if "deletionDate" in body:
        moment = _parse_deletion_date(body.get("deletionDate"), datetime.now(timezone.utc))
        if moment is None:
            return _error("invalid_deletion_date",
                          "The deletion date must be a yyyy-mm-dd date from tomorrow on.", 400)
        extra["DeletionDate"] = _utc_text(moment)

    for attempt in range(EXTEND_RETRIES):
        entity, error = _read_admin_entity(table_client, competition_id)
        if error is not None:
            return error
        if entity.get("Status") == STATUS_DELETED:
            return _error("deleted", "This competition has been deleted; restore it first.", 409)

        try:
            merged, error = _apply_competition_edit(table_client, entity, body, extra,
                                                    etag=_entity_etag(entity))
        except ResourceModifiedError:
            logging.info(f"Competition '{competition_id}' changed during an admin edit "
                         f"(attempt {attempt + 1}/{EXTEND_RETRIES}); retrying")
            continue
        if error is not None:
            return error

        _sync_clock(merged)
        changes = _changes(entity, merged)
        if changes:
            _audit(admin, "competition.update", merged, changes)
        return _admin_competition_response(merged)

    return _error("conflict", "The competition kept changing; please try again.", 409)


def _admin_set_owner(req: func.HttpRequest) -> func.HttpResponse:
    """PUT /api/manage/competitions/{id}/owner {"userId"} — make another
    signed-in user the owner. ONE table transaction in the competition's
    partition: the ownership sentinel is inserted (none yet) or replaced
    etag-conditionally, the new owner row is upserted and EVERY current owner
    row becomes `write` (etag-conditional too). A concurrent swap or legacy
    claim therefore fails the sentinel write of one of them, and a concurrent
    grant change fails a demotion: the loser re-reads and retries the whole
    swap. Works on an unowned (legacy) competition too."""
    target, error = _admin_target(req)
    if error is not None:
        return error
    admin, competition_id, table_client = target

    body = _read_body(req)
    if body is None:
        return _error("invalid_body", "Expected a JSON object body.", 400)
    new_owner = str(body.get("userId") or "").strip().lower()
    if not _GUID_RE.fullmatch(new_owner):
        return _error("invalid_user", "Unknown user.", 400)

    entity, error = _read_admin_entity(table_client, competition_id)
    if error is not None:
        return error
    if entity.get("PurgedUtc"):
        return _error("purged", "This competition has been purged.", 409)

    new_row = _read_users([new_owner]).get(new_owner)
    if new_row is None:
        return _error("user_not_found", "Unknown user.", 404)

    actor = _require_user(req)   # the admin's own userId, for GrantedBy
    if isinstance(actor, func.HttpResponse):
        return actor
    access = get_table_client(_access_table_name())
    if access is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    partition = _access_pk(competition_id)
    for attempt in range(EXTEND_RETRIES):
        try:
            rows = _access_rows(access, competition_id)
        except Exception as e:
            logging.error(f"Error reading the access rows of '{competition_id}': {e}")
            return _error("internal_error", "Could not change the owner.", 500)
        old_owners = [row for row in rows if row.get("Role") == ROLE_OWNER]
        lock = next((row for row in rows if row.get("RowKey") == OWNER_LOCK_ROW_KEY), None)
        if [row["RowKey"] for row in old_owners] == [new_owner]:
            return _json({"competition": entity_to_admin_competition(
                entity, _read_clock_row(competition_id)),
                "access": _access_list(competition_id, access)})

        now = _now_utc()
        lock_row = _owner_lock_row(competition_id, new_owner, now)
        operations = [
            ("create", lock_row) if lock is None else
            ("update", lock_row, {"mode": UpdateMode.REPLACE, "etag": _entity_etag(lock),
                                  "match_condition": MatchConditions.IfNotModified}),
            ("upsert", _owner_row(competition_id, new_owner, actor.user_id, now),
             {"mode": UpdateMode.REPLACE}),
        ]
        for row in old_owners:
            if row["RowKey"] == new_owner:
                continue
            operations.append(("update", {
                "PartitionKey": partition, "RowKey": row["RowKey"], "Role": ROLE_WRITE,
                "GrantedBy": actor.user_id, "GrantedUtc": now,
            }, {"mode": UpdateMode.REPLACE, "etag": _entity_etag(row),
                "match_condition": MatchConditions.IfNotModified}))
        try:
            access.submit_transaction(operations)
        except (TableTransactionError, ResourceExistsError, ResourceModifiedError,
                ResourceNotFoundError) as e:
            logging.info(f"Owner swap of '{competition_id}' lost a race "
                         f"(attempt {attempt + 1}/{EXTEND_RETRIES}): {e}")
            continue
        except Exception as e:
            logging.error(f"Error changing the owner of '{competition_id}': {e}")
            return _error("internal_error", "Could not change the owner.", 500)

        old_ids = [row["RowKey"] for row in old_owners if row["RowKey"] != new_owner]
        old_rows = _read_users(old_ids)
        before = ", ".join((old_rows.get(uid) or {}).get("Email") or uid for uid in old_ids) or None
        _audit(admin, "competition.owner", entity,
               {"owner": [before, new_row.get("Email") or new_owner]},
               target=new_row.get("Email") or "")
        return _json({"competition": entity_to_admin_competition(
            entity, _read_clock_row(competition_id)),
            "access": _access_list(competition_id, access)})

    return _error("conflict", "The access kept changing; please try again.", 409)


def _admin_list_users(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/manage/users — the user directory with first/last seen and how
    many competitions each one owns or has been shared. With `?q=` (at least
    USER_SEARCH_MIN_CHARS) only the users whose name or e-mail contains it, at
    most USER_SEARCH_MAX_RESULTS — the admin "Change owner…" picker. Admins
    see full e-mails; the admin themselves is included."""
    admin = _require_admin(req)
    if isinstance(admin, func.HttpResponse):
        return admin

    query = None
    if "q" in req.params:
        query = " ".join(str(req.params.get("q") or "").split()).lower()[:USER_SEARCH_MAX_QUERY]
        if len(query) < USER_SEARCH_MIN_CHARS:
            return _error("query_too_short",
                          f"Type at least {USER_SEARCH_MIN_CHARS} characters.", 400)

    users = get_table_client(_users_table_name())
    access = get_table_client(_access_table_name())
    identities = get_table_client(_user_identities_table_name())
    if users is None or access is None or identities is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    def scan(rows):
        try:
            return list(rows())
        except ResourceNotFoundError:
            return []

    try:
        rows = scan(lambda: users.query_entities(f"PartitionKey eq '{PK_USER}'"))
        grants = scan(access.list_entities)
        links = scan(lambda: identities.query_entities(f"PartitionKey eq '{PK_IDENTITY}'"))
    except Exception as e:
        logging.error(f"Error listing users for the admin panel: {e}")
        return _error("internal_error", "Could not list users.", 500)

    owned, shared, linked = {}, {}, {}
    for grant in grants:
        if grant.get("Role") not in ROLE_RANK:
            continue   # the ownership sentinel
        counter = owned if grant.get("Role") == ROLE_OWNER else shared
        counter[grant.get("RowKey")] = counter.get(grant.get("RowKey"), 0) + 1
    for link in links:
        linked[link.get("UserId")] = linked.get(link.get("UserId"), 0) + 1

    items = []
    for row in rows:
        user_id = row.get("RowKey") or ""
        if query is not None and query not in (row.get("DisplayName") or "").lower() \
                and query not in (row.get("Email") or "").lower():
            continue
        items.append({
            **_user_ref(user_id, row),
            "firstSeenUtc": row.get("FirstSeenUtc") or None,
            "lastSeenUtc": row.get("LastSeenUtc") or None,
            "owned": owned.get(user_id, 0),
            "shared": shared.get(user_id, 0),
            "identities": linked.get(user_id, 0),
        })
    if query is not None:
        items.sort(key=lambda item: ((item["name"] or item["email"]).lower(), item["userId"]))
        items = items[:USER_SEARCH_MAX_RESULTS]
    else:
        items.sort(key=lambda item: (item["lastSeenUtc"] or "", item["userId"]), reverse=True)
    return _json({"users": items})


def _admin_restore_competition(req: func.HttpRequest) -> func.HttpResponse:
    """Undo a soft delete: re-claim the CODE row (409 code_in_use when someone
    took the code meanwhile — rename and retry), Status=active, and a fresh
    deletion date (body `deletionDate`, default today + RESTORE_DEFAULT_DAYS).
    A purged competition has nothing left to restore, and one whose purge has
    started (PurgingUtc, stamped by _purge_competition before it deletes
    anything) may already have lost its files: both are 409.

    A CODE row this restore claimed is never rolled back on a lost ETag race:
    a concurrent restore may have adopted it (it points here), and deleting it
    would leave that now-active competition without its reservation. A claim
    left on a still-deleted row is harmless — the next restore adopts it and a
    purge releases it — and is released here at once if the row turns out
    purged or purging."""
    target, error = _admin_target(req)
    if error is not None:
        return error
    admin, competition_id, table_client = target

    body = {}
    if req.get_body():
        body = _read_body(req)
        if body is None:
            return _error("invalid_body", "Expected a JSON object body.", 400)

    now = datetime.now(timezone.utc)
    deletion = _midnight(now) + timedelta(days=RESTORE_DEFAULT_DAYS)
    if body.get("deletionDate") not in (None, ""):
        deletion = _parse_deletion_date(body.get("deletionDate"), now)
        if deletion is None:
            return _error("invalid_deletion_date",
                          "The deletion date must be a yyyy-mm-dd date from tomorrow on.", 400)

    claimed_code = ""
    for attempt in range(EXTEND_RETRIES):
        entity, error = _read_admin_entity(table_client, competition_id)
        if error is not None:
            return error
        if entity.get("PurgedUtc") or entity.get("PurgingUtc"):
            if claimed_code:
                _release_code_row(table_client, claimed_code, competition_id)
            if entity.get("PurgedUtc"):
                return _error("purged",
                              "This competition has been purged and cannot be restored.", 409)
            return _error("purging",
                          "This competition's data is being removed; it cannot be restored.", 409)
        if entity.get("Status") != STATUS_DELETED:
            return _error("not_deleted", "This competition is not deleted.", 409)

        # Claim the code first, as create does: a taken code fails here with
        # nothing written. A CODE row still pointing here (a release that
        # failed, or a claim of an earlier attempt or a concurrent restore) is
        # ours already.
        code = entity.get("Code", "")
        if code:
            try:
                table_client.create_entity({
                    "PartitionKey": PK_CODE,
                    "RowKey": code,
                    "CompetitionId": competition_id,
                    "CreatedUtc": _utc_text(now),
                })
                claimed_code = code
            except ResourceExistsError:
                try:
                    owner = table_client.get_entity(partition_key=PK_CODE, row_key=code)
                except ResourceNotFoundError:
                    continue   # released between the two calls; claim again
                if (owner.get("CompetitionId") or "") != competition_id:
                    return _error("code_in_use",
                                  f"The competition code '{code}' is already in use.", 409, code=code)
            except Exception as e:
                logging.error(f"Error reserving competition code '{code}': {e}")
                return _error("internal_error", "Could not restore the competition.", 500)

        updates = {
            "Status": STATUS_ACTIVE,
            "DeleteReason": "",
            "DeletedUtc": "",
            "DeletionDate": _utc_text(deletion),
            "UpdatedUtc": _utc_text(datetime.now(timezone.utc)),
        }
        try:
            table_client.update_entity(
                {"PartitionKey": PK_COMPETITION, "RowKey": competition_id, **updates},
                mode=UpdateMode.MERGE,
                etag=_entity_etag(entity),
                match_condition=MatchConditions.IfNotModified,
            )
        except ResourceModifiedError:
            # The claim stays (see the docstring); the re-read decides.
            logging.info(f"Competition '{competition_id}' changed during restore "
                         f"(attempt {attempt + 1}/{EXTEND_RETRIES}); retrying")
            continue
        except Exception as e:
            if isinstance(e, ResourceNotFoundError):
                if claimed_code:
                    _release_code_row(table_client, claimed_code, competition_id)
                return _error("not_found", "Competition not found.", 404)
            logging.error(f"Error restoring competition '{competition_id}': {e}")
            return _error("internal_error", "Could not restore the competition.", 500)

        merged = dict(entity)
        merged.update(updates)
        _sync_clock(merged)
        _audit(admin, "competition.restore", merged, _changes(entity, merged))
        return _admin_competition_response(merged)

    return _error("conflict", "The competition kept changing; please try again.", 409)


def _admin_purge_competition(req: func.HttpRequest) -> func.HttpResponse:
    """Purge now, exactly as the nightly sweep would: soft delete if needed,
    then _purge_competition — blobs, HOVTP sources and CODE row gone, the row
    replaced by a tombstone. An explicit admin action, so it does NOT obey the
    RETENTION_PURGE_ENABLED kill switch (that guards the unattended sweep).
    The typed code in `confirm` must match."""
    target, error = _admin_target(req)
    if error is not None:
        return error
    admin, competition_id, table_client = target

    body = _read_body(req)
    if body is None:
        return _error("invalid_body", "Expected a JSON object body.", 400)

    entity, error = _read_admin_entity(table_client, competition_id)
    if error is not None:
        return error
    if entity.get("PurgedUtc"):
        return _error("purged", "This competition has already been purged.", 409)

    confirm = normalize_code(body.get("confirm") or "")
    if not confirm or confirm != (entity.get("Code") or ""):
        return _error("confirm_mismatch", "Type the competition code to confirm the purge.", 400)

    before_status = _admin_status(entity)
    if entity.get("Status") != STATUS_DELETED:
        _merged, error = _soft_delete(table_client, entity)
        if error is not None:
            return error
        entity, error = _read_admin_entity(table_client, competition_id)
        if error is not None:
            return error

    if not _purge_competition(table_client, _get_container_client(), entity,
                              datetime.now(timezone.utc)):
        # The soft delete stands (DeletionDate is tonight), so the nightly
        # sweep finishes the purge if this retry is not made first.
        _audit(admin, "competition.purge", entity,
               {"status": [before_status, _admin_status(entity)]}, outcome="failed")
        return _error("purge_failed", "The purge did not complete; try again.", 500)

    stone, error = _read_admin_entity(table_client, competition_id)
    if error is not None:
        return error
    # Status only: the "before" owner e-mail must not outlive the tombstone.
    _audit(admin, "competition.purge", stone, {"status": [before_status, STATUS_PURGED]})
    return _admin_competition_response(stone)


def _admin_delete_competition(req: func.HttpRequest) -> func.HttpResponse:
    """The user DELETE plus an audit row; a second delete is a 409 here."""
    target, error = _admin_target(req)
    if error is not None:
        return error
    admin, competition_id, table_client = target

    entity, error = _read_admin_entity(table_client, competition_id)
    if error is not None:
        return error
    if entity.get("Status") == STATUS_DELETED:
        return _error("deleted", "This competition has already been deleted.", 409)

    merged, error = _soft_delete(table_client, entity)
    if error is not None:
        return error
    _audit(admin, "competition.delete", merged, _changes(entity, merged))
    return _admin_competition_response(merged)


def _admin_sweep_dry_run(req: func.HttpRequest) -> func.HttpResponse:
    """The nightly sweep with purging off. Deletes nothing — but, as in any
    dry-run, the DeletionDate backfill and the clock reconcile still write."""
    admin = _require_admin(req)
    if isinstance(admin, func.HttpResponse):
        return admin

    summary = _run_retention_sweep(datetime.now(timezone.utc), False, dry_run_manual=True)
    _audit(admin, "sweep.dryrun")
    return _json({"summary": summary})


def _hovtp_enabled_setting():
    """HOVTP_ENABLED as the listener reads it — informational here, the
    listener has its own copy. None = not configured on this app."""
    raw = (os.environ.get("HOVTP_ENABLED") or "").strip().lower()
    if not raw:
        return None
    return raw not in ("0", "false", "no")


def _admin_diagnostics(req: func.HttpRequest) -> func.HttpResponse:
    admin = _require_admin(req)
    if isinstance(admin, func.HttpResponse):
        return admin

    config = {
        "retentionPurgeEnabled": _purge_enabled(),
        "hovtpEnabled": _hovtp_enabled_setting(),
        "retentionDays": RETENTION_DAYS,
        "extensionDays": EXTENSION_DAYS,
        "clockTable": _clock_table_name(),
        "adminLogTable": _admin_log_table_name(),
        "auditRetentionDays": AUDIT_RETENTION_DAYS,
        "usersTable": _users_table_name(),
        "userIdentitiesTable": _user_identities_table_name(),
        "competitionAccessTable": _access_table_name(),
        "allowedTenantCount": len(_allowed_tenant_ids()),
        "externalTenantCount": len(_external_tenant_ids()),
        "inactiveUserDays": INACTIVE_USER_DAYS,
    }
    by_status = {STATUS_ACTIVE: 0, STATUS_DELETED: 0, STATUS_PURGED: 0}
    sources_by_status = {HOVTP_STATUS_PENDING: 0, HOVTP_STATUS_ACCEPTED: 0,
                         HOVTP_STATUS_EXPIRED: 0, HOVTP_STATUS_REJECTED: 0}
    counts = {"competitions": by_status, "dueWithin7Days": 0, "pastDeletionDate": 0,
              "hovtpSources": sources_by_status, "hovtpSessions": 0, "clockDrift": 0}
    errors = []
    sweeps = []

    table_client = get_table_client()
    if table_client is None:
        errors.append("Storage configuration invalid.")
    else:
        try:
            competitions = list(table_client.query_entities(f"PartitionKey eq '{PK_COMPETITION}'"))
            sources = list(table_client.query_entities(f"PartitionKey eq '{PK_HOVTP_SOURCE}'"))
            sessions = list(table_client.query_entities(f"PartitionKey eq '{PK_HOVTP_SESSION}'"))
        except Exception as e:
            errors.append(_short_error(e))
            competitions, sources, sessions = [], [], []

        clocks, clock_error = _read_clock_rows()
        if clock_error:
            errors.append(f"Clock table: {clock_error}")

        now = datetime.now(timezone.utc)
        due_before = now + timedelta(days=7)
        for entity in competitions:
            status = _admin_status(entity)
            by_status[status] = by_status.get(status, 0) + 1
            if not clock_error and _clock_differs(
                    _clock_row(entity), clocks.get(str(entity.get("RowKey") or "").lower())):
                counts["clockDrift"] += 1
            if status == STATUS_PURGED:
                continue
            deletion = _effective_deletion_date(entity)
            if deletion <= now:
                counts["pastDeletionDate"] += 1
            elif status == STATUS_ACTIVE and deletion <= due_before:
                counts["dueWithin7Days"] += 1

        now_text = _utc_text(now)
        for source in sources:
            status = _source_status(source, now_text)
            sources_by_status[status] = sources_by_status.get(status, 0) + 1
        counts["hovtpSessions"] = len(sessions)

    log_client = get_table_client(_admin_log_table_name())
    if log_client is None:
        errors.append("Admin log configuration invalid.")
    else:
        try:
            for row in log_client.query_entities(f"PartitionKey eq '{PK_SWEEP}'"):
                sweeps.append(_sweep_to_json(row))
                if len(sweeps) >= SWEEP_HISTORY:
                    break
        except ResourceNotFoundError:
            pass   # no sweep has run yet
        except Exception as e:
            errors.append(f"Admin log: {_short_error(e)}")

    return _json({
        "config": config,
        "storage": {"ok": not errors, "error": "; ".join(errors) or None},
        "counts": counts,
        "sweeps": sweeps,
    })


def _admin_audit_log(req: func.HttpRequest) -> func.HttpResponse:
    """Newest first, `limit` per page; `next` is the `before` of the next page."""
    admin = _require_admin(req)
    if isinstance(admin, func.HttpResponse):
        return admin

    try:
        limit = int(req.params.get("limit") or AUDIT_PAGE_DEFAULT)
    except ValueError:
        return _error("invalid_limit", f"limit must be 1 to {AUDIT_PAGE_MAX}.", 400)
    if not 1 <= limit <= AUDIT_PAGE_MAX:
        return _error("invalid_limit", f"limit must be 1 to {AUDIT_PAGE_MAX}.", 400)

    # The cursor goes into an OData filter, so it is held to the key alphabet.
    before = (req.params.get("before") or "").strip()
    if before and not _ADMIN_LOG_KEY_RE.match(before):
        return _error("invalid_before", "Unknown page cursor.", 400)

    client = get_table_client(_admin_log_table_name())
    if client is None:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    query = f"PartitionKey eq '{PK_AUDIT}'"
    if before:
        query += f" and RowKey ge '{before}'"
    entries = []
    has_more = False
    try:
        for row in client.query_entities(query, results_per_page=limit + 1):
            if before and row.get("RowKey", "") <= before:
                continue   # `ge` includes the cursor row itself
            if len(entries) == limit:
                has_more = True
                break
            entries.append(_audit_to_json(row))
    except ResourceNotFoundError:
        entries = []
    except Exception as e:
        logging.error(f"Error reading the audit log: {e}")
        return _error("internal_error", "Could not read the audit log.", 500)

    return _json({"entries": entries, "next": entries[-1]["id"] if has_more else None})


# ── HTTP routes ───────────────────────────────────────────────────────────────
# The Functions host prepends the default `api` route prefix, so these register
# as /api/competitions and /api/competitions/{id}.

@app.route(route="competitions", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET", "POST"])
def competitions(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "POST":
        return _create_competition(req)
    return _list_competitions(req)


@app.route(route="competitions/{id}", auth_level=func.AuthLevel.ANONYMOUS,
           methods=["GET", "PUT", "PATCH", "DELETE"])
def competition_by_id(req: func.HttpRequest) -> func.HttpResponse:
    if req.method in ("PUT", "PATCH"):
        return _update_competition(req)
    if req.method == "DELETE":
        return _delete_competition(req)
    return _get_competition(req)


@app.route(route="competitions/{id}/extend", auth_level=func.AuthLevel.ANONYMOUS,
           methods=["POST"])
def competition_extend(req: func.HttpRequest) -> func.HttpResponse:
    return _extend_competition(req)


@app.route(route="competitions/{id}/files", auth_level=func.AuthLevel.ANONYMOUS,
           methods=["GET", "POST"])
def competition_files(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "POST":
        return _upload_competition_file(req)
    return _list_competition_files(req)


@app.route(route="competitions/{id}/files/{name}", auth_level=func.AuthLevel.ANONYMOUS,
           methods=["GET", "DELETE"])
def competition_file_by_name(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "DELETE":
        return _delete_competition_file(req)
    return _download_competition_file(req)


@app.route(route="competitions/{id}/hovtp/sources", auth_level=func.AuthLevel.ANONYMOUS,
           methods=["GET"])
def competition_hovtp_sources(req: func.HttpRequest) -> func.HttpResponse:
    return _list_hovtp_sources(req)


@app.route(route="competitions/{id}/hovtp/sources/{ip}/accept",
           auth_level=func.AuthLevel.ANONYMOUS, methods=["POST"])
def competition_hovtp_source_accept(req: func.HttpRequest) -> func.HttpResponse:
    return _accept_hovtp_source(req)


@app.route(route="competitions/{id}/hovtp/sources/{ip}/reject",
           auth_level=func.AuthLevel.ANONYMOUS, methods=["POST"])
def competition_hovtp_source_reject(req: func.HttpRequest) -> func.HttpResponse:
    return _deny_hovtp_source(req)


@app.route(route="competitions/{id}/hovtp/sources/{ip}", auth_level=func.AuthLevel.ANONYMOUS,
           methods=["DELETE"])
def competition_hovtp_source_by_ip(req: func.HttpRequest) -> func.HttpResponse:
    """Revoke: same write as reject, but the already-attached files stay."""
    return _deny_hovtp_source(req)


@app.route(route="competitions/{id}/access", auth_level=func.AuthLevel.ANONYMOUS,
           methods=["GET"])
def competition_access(req: func.HttpRequest) -> func.HttpResponse:
    return _list_access(req)


@app.route(route="competitions/{id}/access/{userId}", auth_level=func.AuthLevel.ANONYMOUS,
           methods=["PUT", "DELETE"])
def competition_access_by_user(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "DELETE":
        return _remove_access(req)
    return _set_access(req)


@app.route(route="users/search", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET"])
def users_search(req: func.HttpRequest) -> func.HttpResponse:
    return _search_users(req)


@app.route(route="users/recent", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET"])
def users_recent(req: func.HttpRequest) -> func.HttpResponse:
    return _recent_share_users(req)


@app.route(route="users/me", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET"])
def users_me(req: func.HttpRequest) -> func.HttpResponse:
    return _current_user(req)


# Admin routes. "manage", not "admin": the Functions host reserves the `admin`
# route segment for its own management API.

@app.route(route="manage/competitions", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET"])
def manage_competitions(req: func.HttpRequest) -> func.HttpResponse:
    return _admin_list_competitions(req)


@app.route(route="manage/competitions/{id}", auth_level=func.AuthLevel.ANONYMOUS,
           methods=["GET", "PATCH", "DELETE"])
def manage_competition_by_id(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "PATCH":
        return _admin_update_competition(req)
    if req.method == "DELETE":
        return _admin_delete_competition(req)
    return _admin_get_competition(req)


@app.route(route="manage/competitions/{id}/restore", auth_level=func.AuthLevel.ANONYMOUS,
           methods=["POST"])
def manage_competition_restore(req: func.HttpRequest) -> func.HttpResponse:
    return _admin_restore_competition(req)


@app.route(route="manage/competitions/{id}/purge", auth_level=func.AuthLevel.ANONYMOUS,
           methods=["POST"])
def manage_competition_purge(req: func.HttpRequest) -> func.HttpResponse:
    return _admin_purge_competition(req)


@app.route(route="manage/competitions/{id}/owner", auth_level=func.AuthLevel.ANONYMOUS,
           methods=["PUT"])
def manage_competition_owner(req: func.HttpRequest) -> func.HttpResponse:
    return _admin_set_owner(req)


@app.route(route="manage/users", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET"])
def manage_users(req: func.HttpRequest) -> func.HttpResponse:
    return _admin_list_users(req)


@app.route(route="manage/sweep/dry-run", auth_level=func.AuthLevel.ANONYMOUS, methods=["POST"])
def manage_sweep_dry_run(req: func.HttpRequest) -> func.HttpResponse:
    return _admin_sweep_dry_run(req)


@app.route(route="manage/diagnostics", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET"])
def manage_diagnostics(req: func.HttpRequest) -> func.HttpResponse:
    return _admin_diagnostics(req)


@app.route(route="manage/audit", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET"])
def manage_audit(req: func.HttpRequest) -> func.HttpResponse:
    return _admin_audit_log(req)


@app.route(route="health", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET"])
def health(req: func.HttpRequest) -> func.HttpResponse:
    """Liveness probe. Deliberately touches no storage and needs no identity."""
    return _json({"status": "ok", "service": "fs-platform"})


# Same 03:00 UTC schedule as the tool Function Apps' own clean-up timers, so the
# platform and every tool decide on the same night.
@app.timer_trigger(schedule="0 0 3 * * *", arg_name="timer", run_on_startup=False,
                   use_monitor=True)
def retention_sweep(timer: func.TimerRequest) -> None:
    _run_retention_sweep(datetime.now(timezone.utc), _purge_enabled())


# The FSM ingest is NOT here: FSM pushes over HOVTP to its own Function App,
# `infra/hovtp/`, which writes <guid>/fsm[-pending]/ that these routes manage.
