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
    GET    /api/health                  -> 200 {"status": "ok"}

    GET    /api/competitions/{id}/files          -> 200 {"files": [FileInfo, ...]}
    POST   /api/competitions/{id}/files          -> 201 FileInfo
                                                    ?filename=&sourceTool=, raw body
    GET    /api/competitions/{id}/files/{name}   -> 200 bytes  (?source=upload|fsm)
    DELETE /api/competitions/{id}/files/{name}   -> 200 {"status": "deleted", ...}

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

Every non-2xx body is {"error": "<machine_code>", "message": "<human text>"}.

Storage layout — one `competitions` table, two row kinds:

    PartitionKey="COMPETITION", RowKey=<guid>            the competition itself
    PartitionKey="CODE",        RowKey=<normalized code> -> CompetitionId

The CODE row is both the uniqueness constraint (inserted first, so a duplicate
fails atomically with 409) and the O(1) code->GUID lookup the future FSM ingest
needs. Blob data lives in the shared `competition-data` container keyed by GUID:

    <guid>/uploads/...   cross-tool data reuse (tool Function Apps get read-only
                         RBAC here — see infra/modules/shared-data-access.bicep)
    <guid>/fsm/...       RESERVED for the FSM ingest (not built)
"""

import base64
import json
import logging
import os
import re
import unicodedata
from datetime import datetime, timezone
from uuid import uuid4

from urllib.parse import quote

import azure.functions as func
from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
from azure.data.tables import TableClient, UpdateMode
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

COMPETITIONS_TABLE = "competitions"
PK_COMPETITION = "COMPETITION"
PK_CODE = "CODE"

STATUS_ACTIVE = "active"
STATUS_DELETED = "deleted"

MAX_NAME_LENGTH = 200
MAX_CODE_LENGTH = 64
MAX_VENUE_LENGTH = 200

DATA_CONTAINER = os.environ.get("COMPETITION_DATA_CONTAINER", "competition-data")

SOURCE_UPLOAD = "upload"
SOURCE_FSM = "fsm"

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

def get_table_client(table_name: str = COMPETITIONS_TABLE):
    """Table client via managed identity (deployed) or connection string (local)."""
    try:
        account_name = os.environ.get("AzureWebJobsStorage__accountName")
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
        account_name = os.environ.get("AzureWebJobsStorage__accountName")
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
    """RESERVED blob prefix for the future FSM datafeed/PDF ingest."""
    return f"{competition_id}/fsm/"


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
    }
    try:
        table_client.create_entity(entity)
    except Exception as e:
        logging.error(f"Error creating competition '{code}', rolling back code reservation: {e}")
        _delete_code_row(table_client, code)
        return _error("internal_error", "Could not create the competition.", 500)

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

    updates = {}

    if "name" in body:
        name = _clean(body.get("name"), MAX_NAME_LENGTH)
        if not name:
            return _error("invalid_name", "A competition name is required.", 400)
        updates["Name"] = name

    for field, column, max_length in (("date", "StartDate", 10), ("endDate", "EndDate", 10)):
        if field in body:
            value = _clean(body.get(field), max_length)
            if not _valid_date(value):
                return _error("invalid_date", "Dates must be in yyyy-mm-dd format.", 400)
            updates[column] = value

    if "startDate" in body and "date" not in body:
        value = _clean(body.get("startDate"), 10)
        if not _valid_date(value):
            return _error("invalid_date", "Dates must be in yyyy-mm-dd format.", 400)
        updates["StartDate"] = value

    if "venue" in body:
        updates["Venue"] = _clean(body.get("venue"), MAX_VENUE_LENGTH)

    old_code = entity.get("Code", "")
    new_code = old_code
    if "code" in body:
        new_code = normalize_code(body.get("code"))
        if not new_code:
            return _error("invalid_code", "The competition code must contain letters or digits.", 400)

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
            return _error("code_in_use", f"The competition code '{new_code}' is already in use.", 409, code=new_code)
        except Exception as e:
            logging.error(f"Error reserving competition code '{new_code}': {e}")
            return _error("internal_error", "Could not update the competition.", 500)
        updates["Code"] = new_code

    updates["UpdatedUtc"] = _now_utc()

    try:
        table_client.update_entity(
            {"PartitionKey": PK_COMPETITION, "RowKey": competition_id, **updates},
            mode=UpdateMode.MERGE,
        )
    except Exception as e:
        logging.error(f"Error updating competition '{competition_id}': {e}")
        if renaming:
            _delete_code_row(table_client, new_code)
        return _error("internal_error", "Could not update the competition.", 500)

    if renaming:
        _delete_code_row(table_client, old_code)

    merged = dict(entity)
    merged.update(updates)
    return _json(entity_to_competition(merged))


def _delete_competition(req: func.HttpRequest) -> func.HttpResponse:
    """
    Soft delete: the row survives (history, and any tool that stored the GUID
    keeps resolving it) but drops out of the list. The CODE row IS removed so
    the code can be reused — a deleted competition must not squat on it.
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

    updates = {
        "Status": STATUS_DELETED,
        "DeletedBy": email,
        "DeletedUtc": _now_utc(),
        "UpdatedUtc": _now_utc(),
    }

    try:
        table_client.update_entity(
            {"PartitionKey": PK_COMPETITION, "RowKey": competition_id, **updates},
            mode=UpdateMode.MERGE,
        )
    except Exception as e:
        logging.error(f"Error deleting competition '{competition_id}': {e}")
        return _error("internal_error", "Could not delete the competition.", 500)

    _delete_code_row(table_client, entity.get("Code", ""))

    merged = dict(entity)
    merged.update(updates)
    return _json(entity_to_competition(merged))


# ── file pool handlers ────────────────────────────────────────────────────────
# competition-data/<guid>/uploads/<name> is name-keyed and overwritten in place:
# the same filename is the same logical file, which is what an FSM re-export of
# an already-uploaded PDF means. <guid>/fsm/ is written only by the (unbuilt)
# ingest, so it is readable but never writable through these routes.

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


@app.route(route="health", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET"])
def health(req: func.HttpRequest) -> func.HttpResponse:
    """Liveness probe. Deliberately touches no storage and needs no identity."""
    return _json({"status": "ok", "service": "fs-platform"})


# ── RESERVED: FSM ingest seams (workstream 5 — do not build yet) ──────────────
#
# The FSM (figure skating management system) will POST datafeeds and PDFs keyed
# by the competition CODE, not the GUID; the CODE row above is the O(1) lookup.
# Ingest is machine-to-machine, so it is NOT gated by the user-email header —
# it gets its own pre-shared key, checked here rather than via Easy Auth:
#
# def _ingest_key_ok(req: func.HttpRequest) -> bool:
#     expected = os.environ.get("INGEST_API_KEY")
#     if not expected:
#         return False           # closed by default, unlike PROXY_SHARED_SECRET
#     return (req.headers.get("x-ingest-key") or "") == expected
#
# @app.route(route="ingest/datafeed", auth_level=func.AuthLevel.ANONYMOUS, methods=["POST"])
# def ingest_datafeed(req):      # ?code=<competition code>
#     ...  # resolve CODE row -> guid, write competition_fsm_prefix(guid) + 'datafeed/...'
#
# @app.route(route="ingest/pdf", auth_level=func.AuthLevel.ANONYMOUS, methods=["POST"])
# def ingest_pdf(req):           # ?code=<competition code>
#     ...  # write competition_fsm_prefix(guid) + 'pdf/...'
