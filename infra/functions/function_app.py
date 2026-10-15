"""figureskatingtools.com platform API — the central competition registry.

This Function App sits behind the site's router Web App (`server/server.js`),
which owns the Entra login and forwards every `/api/*` request here with

    X-Proxy-Secret:          the shared secret (PROXY_SHARED_SECRET)
    X-Forwarded-User-Email:  the signed-in user's email

The browser never reaches this app directly.

HTTP contract (Azure Functions' default `api` route prefix makes these the
literal URLs the router proxies to — and the URLs
`packages/shared-ui/src/competition.ts` calls):

    GET    /api/competitions            -> 200 [Competition, ...]
    POST   /api/competitions            -> 201 Competition
                                           409 {"error": "code_in_use", ...}
    GET    /api/competitions/{id}       -> 200 Competition | 404
    PUT    /api/competitions/{id}       -> 200 Competition | 404
    PATCH  /api/competitions/{id}       -> 200 Competition | 404 | 409
    DELETE /api/competitions/{id}       -> 200 Competition (status "deleted") | 404
    POST   /api/competitions/{id}/extend -> 200 Competition (deletionDate + 7 days) | 404
    GET    /api/health                  -> 200 {"status": "ok"}

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
      "status":    "active" | "deleted"
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
proxy secret must be configured and match, and the e-mail in
X-Forwarded-User-Email must be in ADMIN_EMAILS. Every mutation writes an AUDIT
row to the `adminlog` table (see "Admin log" below):

    GET    /api/manage/competitions?status=active|deleted|purged|all
                                           -> 200 {"competitions": [AdminCompetition, ...]}
    GET    /api/manage/competitions/{id}   -> 200 {"competition", "files", "hovtp"}
    PATCH  /api/manage/competitions/{id}   -> 200 {"competition"}  (+ createdBy, deletionDate)
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
     after SWEEP_LOG_RETENTION_DAYS.

RETENTION_PURGE_ENABLED (app setting, Bicep-owned, on by default) must be
"true" for steps 2–4 and 6 to delete anything; "false" is the kill switch —
they then only log what they would do. The admin "Purge now" is an explicit
action and does not obey it.

Admin log — table `adminlog` (ADMIN_LOG_TABLE), written only by this app:

    PartitionKey="AUDIT", RowKey=<inverted ticks>_<uuid>   Utc, Actor (the
        admin's e-mail), Action, CompetitionId, CompetitionCode, Changes (JSON
        {field: [before, after]}, changed fields only), Outcome
    PartitionKey="SWEEP", RowKey=<inverted ticks>_<uuid>   Utc, PurgeEnabled,
        DryRunManual, Summary (JSON) — one row per sweep run

Inverted ticks make ascending RowKey order newest first. Written after the
action succeeded, best effort: a failed write is logged, never rolled back.
"""

import base64
import hmac
import ipaddress
import json
import logging
import os
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from urllib.parse import quote

import azure.functions as func
from azure.core import MatchConditions
from azure.core.exceptions import (
    ResourceExistsError,
    ResourceModifiedError,
    ResourceNotFoundError,
)
from azure.data.tables import TableClient, UpdateMode
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


# ── auth (verbatim contract from the tool Function Apps) ──────────────────────

def _proxy_secret_ok(req: func.HttpRequest) -> bool:
    """
    Verify the request came from the Web App proxy by checking the shared
    secret header. The function endpoint is public, so this prevents anyone
    from spoofing the X-Forwarded-User-Email header directly.

    Enforced only when PROXY_SHARED_SECRET is set (so local dev and any
    brief pre-rollout window fail open rather than locking everyone out).
    """
    expected = os.environ.get("PROXY_SHARED_SECRET")
    if not expected:
        return True
    provided = req.headers.get("X-Proxy-Secret") or req.headers.get("x-proxy-secret")
    return provided == expected


def _decode_jwt_payload(token: str) -> dict | None:
    """Decode the payload of a JWT token without verification (base64 only)."""
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return None
        payload_b64 = parts[1]
        payload_b64 += '=' * (4 - len(payload_b64) % 4)
        payload_bytes = base64.urlsafe_b64decode(payload_b64)
        return json.loads(payload_bytes)
    except Exception as e:
        logging.error(f"Error decoding JWT payload: {e}")
        return None


def get_user_email_from_header(req: func.HttpRequest) -> str | None:
    """
    Extracts the user email from the headers injected by App Service Easy Auth
    or forwarded by the router Web App, or from an Authorization Bearer JWT.
    Returns None (=> 401) when the proxy shared secret doesn't match.
    """
    # 0. Reject requests that didn't come through the Web App proxy
    if not _proxy_secret_ok(req):
        logging.warning("Proxy shared secret missing or mismatched; rejecting request")
        return None

    # 1. Direct header (standard Easy Auth)
    val = req.headers.get("X-MS-CLIENT-PRINCIPAL-NAME") or req.headers.get("x-ms-client-principal-name")
    if val:
        return val

    # 2. Forwarded header from the router (server/server.js)
    forwarded = req.headers.get("X-Forwarded-User-Email") or req.headers.get("x-forwarded-user-email")
    if forwarded:
        return forwarded

    # 3. Base64 principal header
    header = req.headers.get("x-ms-client-principal") or req.headers.get("X-MS-CLIENT-PRINCIPAL")
    if header:
        try:
            decoded = base64.b64decode(header).decode("utf-8")
            principal = json.loads(decoded)
            return principal.get("userDetails")
        except Exception as e:
            logging.error(f"Error parsing auth header: {e}")

    # 4. Authorization Bearer token
    auth_header = req.headers.get("Authorization") or req.headers.get("authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        claims = _decode_jwt_payload(auth_header[7:])
        if claims:
            email = (claims.get("preferred_username") or claims.get("email")
                     or claims.get("upn") or claims.get("unique_name"))
            if not email:
                emails = claims.get("emails")
                if isinstance(emails, list) and emails:
                    email = emails[0]
            if not email:
                email = claims.get("name") or claims.get("oid")
            if email:
                return email

    logging.warning("No identity found on request")
    return None


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
    """Gate + route params shared by the per-source routes.

    -> ((competition_id, ip, email), None) or (None, error response).
    """
    email = get_user_email_from_header(req)
    if not email:
        return None, _error("unauthorized", "Sign-in required.", 401)

    competition_id = req.route_params.get("id")
    if not competition_id:
        return None, _error("invalid_id", "A competition id is required.", 400)

    ip = _route_ip(req)
    if not ip:
        return None, _error("invalid_ip", "A valid source IP address is required.", 400)

    return (competition_id, ip, email), None


# ── request handlers ──────────────────────────────────────────────────────────
# The @app.route entry points below are thin adapters; all logic lives in these
# plain functions so the test suite can drive them without the Functions host.

def _list_competitions(req: func.HttpRequest) -> func.HttpResponse:
    email = get_user_email_from_header(req)
    if not email:
        return _error("unauthorized", "Sign-in required.", 401)

    include_deleted = (req.params.get("includeDeleted") or "").lower() in ("1", "true", "yes")

    table_client = get_table_client()
    if not table_client:
        return _error("storage_unavailable", "Storage configuration invalid.", 500)

    try:
        _ensure_table(table_client)
        competitions = []
        for entity in table_client.query_entities(f"PartitionKey eq '{PK_COMPETITION}'"):
            competition = entity_to_competition(entity)
            if not include_deleted and competition["status"] == STATUS_DELETED:
                continue
            competitions.append(competition)

        competitions.sort(key=_sort_key, reverse=True)
        return _json(competitions)
    except Exception as e:
        logging.error(f"Error listing competitions: {e}")
        return _error("internal_error", "Could not list competitions.", 500)


def _create_competition(req: func.HttpRequest) -> func.HttpResponse:
    email = get_user_email_from_header(req)
    if not email:
        return _error("unauthorized", "Sign-in required.", 401)

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

    _sync_clock(entity)
    return _json(entity_to_competition(entity), 201)


def _get_competition(req: func.HttpRequest) -> func.HttpResponse:
    email = get_user_email_from_header(req)
    if not email:
        return _error("unauthorized", "Sign-in required.", 401)

    competition_id = req.route_params.get("id")
    if not competition_id:
        return _error("invalid_id", "A competition id is required.", 400)

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

    return _json(entity_to_competition(entity))


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
    email = get_user_email_from_header(req)
    if not email:
        return _error("unauthorized", "Sign-in required.", 401)

    competition_id = req.route_params.get("id")
    if not competition_id:
        return _error("invalid_id", "A competition id is required.", 400)

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
    return _json(entity_to_competition(merged))


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
    """
    email = get_user_email_from_header(req)
    if not email:
        return _error("unauthorized", "Sign-in required.", 401)

    competition_id = req.route_params.get("id")
    if not competition_id:
        return _error("invalid_id", "A competition id is required.", 400)

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
        return _json(entity_to_competition(entity))

    merged, error = _soft_delete(table_client, entity)
    if error is not None:
        return error
    return _json(entity_to_competition(merged))


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
    email = get_user_email_from_header(req)
    if not email:
        return _error("unauthorized", "Sign-in required.", 401)

    competition_id = req.route_params.get("id")
    if not competition_id:
        return _error("invalid_id", "A competition id is required.", 400)

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
        return _json(entity_to_competition(merged))

    return _error("conflict", "The competition kept changing; please try again.", 409)


# ── file pool handlers ────────────────────────────────────────────────────────
# competition-data/<guid>/uploads/<name> is name-keyed and overwritten in place:
# the same filename is the same logical file, which is what an FSM re-export of
# an already-uploaded PDF means. <guid>/fsm/ is written by the HOVTP listener
# (infra/hovtp/) and, on accept, by _attach_pending — never by these routes, so
# it is readable but not writable or deletable through them.

def _list_competition_files(req: func.HttpRequest) -> func.HttpResponse:
    email = get_user_email_from_header(req)
    if not email:
        return _error("unauthorized", "Sign-in required.", 401)

    competition_id = req.route_params.get("id")
    if not competition_id:
        return _error("invalid_id", "A competition id is required.", 400)

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
    email = get_user_email_from_header(req)
    if not email:
        return _error("unauthorized", "Sign-in required.", 401)

    competition_id = req.route_params.get("id")
    if not competition_id:
        return _error("invalid_id", "A competition id is required.", 400)

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
                "uploadedBy": _ascii_metadata(email),
                "sourceTool": source_tool,
                "origName": quote(str(req.params.get("filename") or ""), safe=""),
            },
            content_settings=ContentSettings(content_type=content_type),
        )
    except Exception as e:
        logging.error(f"Error uploading '{name}' for competition '{competition_id}': {e}")
        return _error("internal_error", "Could not store the file.", 500)

    return _json({
        "name": name,
        "source": SOURCE_UPLOAD,
        "size": len(body),
        "contentType": content_type,
        "uploadedUtc": _now_utc(),
        "uploadedBy": email,
        "sourceTool": source_tool,
    }, 201)


def _download_competition_file(req: func.HttpRequest) -> func.HttpResponse:
    email = get_user_email_from_header(req)
    if not email:
        return _error("unauthorized", "Sign-in required.", 401)

    competition_id = req.route_params.get("id")
    if not competition_id:
        return _error("invalid_id", "A competition id is required.", 400)

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
    email = get_user_email_from_header(req)
    if not email:
        return _error("unauthorized", "Sign-in required.", 401)

    competition_id = req.route_params.get("id")
    if not competition_id:
        return _error("invalid_id", "A competition id is required.", 400)

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

    return _json({"status": "deleted", "name": name, "source": SOURCE_UPLOAD})


# ── HOVTP source handlers ─────────────────────────────────────────────────────

def _list_hovtp_sources(req: func.HttpRequest) -> func.HttpResponse:
    email = get_user_email_from_header(req)
    if not email:
        return _error("unauthorized", "Sign-in required.", 401)

    competition_id = req.route_params.get("id")
    if not competition_id:
        return _error("invalid_id", "A competition id is required.", 400)

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
    competition_id, ip, email = target

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
    competition_id, ip, email = target

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

    merged = dict(source)
    merged.update(updates)
    return _json({"source": _source_to_json(merged, _now_utc()), "deleted": deleted})


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

    # 1. Deleted first, so the HOVTP listener answers 451 and the API 404s an
    #    extend from here on. Conditional: an extend that just landed wins and
    #    the row is reconsidered tomorrow.
    if entity.get("Status") != STATUS_DELETED:
        updates = {
            "Status": STATUS_DELETED,
            "DeletedUtc": entity.get("DeletedUtc") or now_text,
            "DeleteReason": entity.get("DeleteReason") or AUTO_CLEANUP_ACTOR,
            "UpdatedUtc": now_text,
        }
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
            logging.error(f"Retention: could not mark '{competition_id}' deleted: {e}")
            return False
        _sync_clock({**entity, **updates})

    code_ok = _release_code_row(table_client, entity.get("Code", ""), competition_id)
    _sources, sources_ok = _delete_hovtp_sources(table_client, competition_id)
    if container is None:
        blobs, blobs_ok = 0, False
    else:
        blobs, blobs_ok = _delete_competition_blobs(container, competition_id)
    if not (code_ok and sources_ok and blobs_ok):
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
    logging.info(f"Retention sweep ({'purge' if purge_enabled else 'dry-run'}): {summary}")
    _record_sweep(now, purge_enabled, summary, dry_run_manual)
    return summary


def _sweep_registry(now: datetime, purge_enabled: bool) -> dict:
    """Steps 1–5 of the sweep (see the module docstring)."""
    summary = {"backfilled": 0, "purged": 0, "would_purge": 0, "failed": 0,
               "resweeps": 0, "sessions_deleted": 0, "sessions_would_delete": 0,
               "clock_synced": 0, "audit_pruned": 0, "audit_would_prune": 0,
               "sweeps_pruned": 0, "sweeps_would_prune": 0}

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
# app's hostname is public, so the decision is made again here from its own
# copy of the allow-list. Unlike get_user_email_from_header this gate FAILS
# CLOSED: no configured secret means nobody is an admin, and the identity comes
# only from the router's X-Forwarded-User-Email — never from the unverified
# X-MS-*/JWT fallbacks.

def _admin_emails() -> frozenset:
    """ADMIN_EMAILS (comma-separated) -> lowercased set. Empty = no admins."""
    raw = os.environ.get("ADMIN_EMAILS") or ""
    return frozenset(part.strip().lower() for part in raw.split(",") if part.strip())


def _require_admin(req: func.HttpRequest):
    """-> the admin's lowercased e-mail, or the 401/403 response to return."""
    expected = os.environ.get("PROXY_SHARED_SECRET") or ""
    provided = req.headers.get("X-Proxy-Secret") or req.headers.get("x-proxy-secret") or ""
    if not expected or not hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
        logging.warning("Admin route: proxy shared secret unset, missing or mismatched")
        return _error("unauthorized", "Sign-in required.", 401)

    email = (req.headers.get("X-Forwarded-User-Email")
             or req.headers.get("x-forwarded-user-email") or "").strip().lower()
    if not email or email not in _admin_emails():
        return _error("admin_required", "Administrator access required.", 403)
    return email


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


def _audit(actor: str, action: str, entity=None, changes=None, outcome: str = "ok") -> bool:
    """One AUDIT row. `changes` is {field: [before, after]}, changed fields only."""
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

    competition_id = req.route_params.get("id")
    if not competition_id:
        return None, _error("invalid_id", "A competition id is required.", 400)

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
    competitions = [
        entity_to_admin_competition(entity, clocks.get(str(entity.get("RowKey") or "").lower()))
        for entity in entities
        if status == "all" or _admin_status(entity) == status
    ]
    competitions.sort(key=_sort_key, reverse=True)
    return _json({"competitions": competitions})


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

    return _json({
        "competition": entity_to_admin_competition(entity, _read_clock_row(competition_id)),
        "files": files,
        "hovtp": hovtp,
    })


def _admin_update_competition(req: func.HttpRequest) -> func.HttpResponse:
    """The user PATCH (same validation, same CODE-row move) plus the owner
    (`createdBy`) and the deletion date — any day from tomorrow on, synced
    into the clock table at once. Etag-conditional with retries, so the audit
    row's "before" is the version the write replaced."""
    target, error = _admin_target(req)
    if error is not None:
        return error
    admin, competition_id, table_client = target

    body = _read_body(req)
    if body is None:
        return _error("invalid_body", "Expected a JSON object body.", 400)

    extra = {}
    if "createdBy" in body:
        owner = body.get("createdBy")
        owner = "" if owner is None else owner
        if not isinstance(owner, str):
            return _error("invalid_created_by", "The owner must be an e-mail address.", 400)
        owner = owner.strip()
        if len(owner) > MAX_EMAIL_LENGTH or (owner and (
                owner.count("@") != 1 or any(c.isspace() for c in owner))):
            return _error("invalid_created_by", "The owner must be an e-mail address.", 400)
        extra["CreatedBy"] = owner

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


def _admin_restore_competition(req: func.HttpRequest) -> func.HttpResponse:
    """Undo a soft delete: re-claim the CODE row (409 code_in_use when someone
    took the code meanwhile — rename and retry), Status=active, and a fresh
    deletion date (body `deletionDate`, default today + RESTORE_DEFAULT_DAYS).
    A purged competition has nothing left to restore."""
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

    for attempt in range(EXTEND_RETRIES):
        entity, error = _read_admin_entity(table_client, competition_id)
        if error is not None:
            return error
        if entity.get("PurgedUtc"):
            return _error("purged", "This competition has been purged and cannot be restored.", 409)
        if entity.get("Status") != STATUS_DELETED:
            return _error("not_deleted", "This competition is not deleted.", 409)

        # Claim the code first, as create does: a taken code fails here with
        # nothing written. A CODE row still pointing here (a release that
        # failed) is ours already.
        code = entity.get("Code", "")
        claimed = False
        if code:
            try:
                table_client.create_entity({
                    "PartitionKey": PK_CODE,
                    "RowKey": code,
                    "CompetitionId": competition_id,
                    "CreatedUtc": _utc_text(now),
                })
                claimed = True
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
            if claimed:
                _delete_code_row(table_client, code)
            logging.info(f"Competition '{competition_id}' changed during restore "
                         f"(attempt {attempt + 1}/{EXTEND_RETRIES}); retrying")
            continue
        except Exception as e:
            if claimed:
                _delete_code_row(table_client, code)
            if isinstance(e, ResourceNotFoundError):
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
