"""figureskatingtools.com HOVTP listener — the FS Manager (FSM) push receiver.

FSM (Swiss Timing) distributes ODF XML messages and report PDFs over **HOVTP**
(HTTP-based OVTP, Swiss Timing spec 1.0). This Function App is the endpoint FSM
posts to. It is deliberately a *separate* app from the platform API
(`infra/functions`) so it can be switched off on its own (`HOVTP_ENABLED=false`,
`az functionapp stop`, or an RBAC revoke) without taking the site down.

FSM sends no credentials, so trust is per **source IP**: an unknown IP's files
are quarantined (never dropped) and the site prompts an operator to accept the
source for 1/2/3/7 days. Accepting attaches the quarantined files to the
competition's file pool.

HTTP contract (the Functions host prepends the default `api` route prefix):

    POST    /api/hovtp                 -> 200 | 400 | 413 | 450 | 451 | 500 | 503
    POST    /api/hovtp/{code}          -> same; the path code wins over the body
    OPTIONS /api/hovtp[/{code}]        -> 200, status/keep-alive, NO side effects
    GET     /api/health                -> 200 {"status": "ok"}

Every response — success or failure — carries the HOVTP response headers:

    Cache-Control:                no-cache
    X-HOVTP-Environment:          our environment (echoed, never refused)
    X-HOVTP-Last-Serial-Number:   last accepted serial for the session, 0 if none
    X-HOVTP-Keep-Alive-Interval:  seconds, when HOVTP_KEEP_ALIVE_SECONDS > 0
    X-HOVTP-Error-Reason:         human text, on failures only

Storage — the platform's `competitions` table gains two row kinds:

    PartitionKey="HOVTPSOURCE", RowKey="<guid>_<ip>"   the per-IP trust row
    PartitionKey="HOVTPSESSION", RowKey="<uuid>"       the serial-number cursor

and the shared `competition-data` container two prefixes:

    <guid>/fsm/<name>                 accepted, FLAT (the pool lists these)
    <guid>/fsm-pending/<ip>/<name>    quarantined until the source is accepted

Only `DT_PDF`, `DT_PARTIC`, `DT_PARTIC_TEAMS`, `DT_SCHEDULE` and
`DT_SCHEDULE_UPDATE` are stored (override with HOVTP_ALLOWED_DOCUMENT_TYPES).
Anything else — `DT_RESULT` above all, which FSM re-sends after every skater —
is answered 200 and dropped, so FSM keeps streaming without filling the pool.

See README.md for the operator-facing contract and the FSM settings to enter.
"""

import base64
import binascii
import io
import ipaddress
import json
import logging
import os
import re
import unicodedata
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone

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

# ── shared contract with infra/functions/function_app.py ──────────────────────
# KEEP IN SYNC: table name, partition keys and the status value below are the
# platform API's; the reader side (competition lookup, source management) lives
# there and must agree on every string.

COMPETITIONS_TABLE = "competitions"
PK_COMPETITION = "COMPETITION"
PK_CODE = "CODE"
PK_HOVTP_SOURCE = "HOVTPSOURCE"
PK_HOVTP_SESSION = "HOVTPSESSION"

STATUS_DELETED = "deleted"

SOURCE_PENDING = "pending"
SOURCE_ACCEPTED = "accepted"
SOURCE_REJECTED = "rejected"

MAX_CODE_LENGTH = 64
MAX_FILENAME_LENGTH = 200

DATA_CONTAINER = os.environ.get("COMPETITION_DATA_CONTAINER", "competition-data")

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

# Control chars break HTTP headers; '#?%' break URLs (the blob name travels in
# the path of /api/competitions/{id}/files/{name}); '"' breaks Content-Disposition.
_FILENAME_STRIP_RE = re.compile(r'[\x00-\x1f\x7f#?%"]')

# ── HOVTP constants ───────────────────────────────────────────────────────────

MAX_MESSAGE_SIZE = 50 * 1024 * 1024          # ≈ 37 MiB of PDF after base64
MAX_SERIAL = 2 ** 64 - 1

DT_PDF = "DT_PDF"
DEFAULT_ALLOWED_DOCUMENT_TYPES = (
    "DT_PDF,DT_PARTIC,DT_PARTIC_TEAMS,DT_SCHEDULE,DT_SCHEDULE_UPDATE"
)

# Quarantine quotas — an unaccepted source must never be able to fill the
# account, but it must also never lose data silently: over quota we answer 451
# so FSM (and the operator) see the refusal.
MAX_PENDING_FILES = 200
MAX_PENDING_BYTES = 200 * 1024 * 1024
MAX_PENDING_SOURCES = 20

MAX_EXTRA_METADATA_KEYS = 24
MAX_METADATA_BYTES = 6 * 1024
_METADATA_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# `X-*` headers that are infrastructure, not data-layer information: they are
# added by App Service / Front Door / our own transport and would only pollute
# the blob metadata.
_INFRA_HEADER_PREFIXES = (
    "x-hovtp-",
    "x-forwarded-",
    "x-client-",
    "x-arr-",
    "x-ms-",
    "x-original-",
    "x-waws-",
    "x-site-",
    "x-appservice-",
    "x-azure-",
)

SERIAL_COMMIT_RETRIES = 3


# ── settings (read per call so an app-setting change takes effect at once) ────

def _setting(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _enabled() -> bool:
    """The kill switch. Anything but 0/false/no keeps the receiver open."""
    return _setting("HOVTP_ENABLED", "true").lower() not in ("0", "false", "no")


def _environment() -> str:
    return _setting("HOVTP_ENVIRONMENT", "Test") or "Test"


def _strict_serial() -> bool:
    return _setting("HOVTP_STRICT_SERIAL", "false").lower() in ("1", "true", "yes")


def _keep_alive() -> int:
    try:
        return int(_setting("HOVTP_KEEP_ALIVE_SECONDS", "60"))
    except ValueError:
        return 60


def _trusted_hops() -> int:
    try:
        return max(0, int(_setting("HOVTP_TRUSTED_PROXY_HOPS", "0")))
    except ValueError:
        return 0


def _allowed_document_types() -> set[str]:
    raw = _setting("HOVTP_ALLOWED_DOCUMENT_TYPES", DEFAULT_ALLOWED_DOCUMENT_TYPES)
    return {part.strip().upper() for part in raw.split(",") if part.strip()}


# ── storage clients (KEEP IN SYNC with infra/functions/function_app.py) ───────

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


def competition_fsm_prefix(competition_id: str) -> str:
    """Accepted FSM files. FLAT — the pool listing skips nested names."""
    return f"{competition_id}/fsm/"


def competition_pending_prefix(competition_id: str, ip: str) -> str:
    """Quarantined files for one not-yet-accepted source."""
    return f"{competition_id}/fsm-pending/{ip}/"


def source_row_key(competition_id: str, ip: str) -> str:
    return f"{competition_id}_{ip}"


# ── helpers (KEEP IN SYNC with infra/functions/function_app.py) ───────────────

def _now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_utc(value) -> str:
    if not value:
        return ""
    try:
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (AttributeError, TypeError, ValueError):
        return str(value)


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


def _ascii_metadata(value) -> str:
    """Blob metadata rides in HTTP headers, which must be ASCII."""
    return str(value or "").encode("ascii", "replace").decode("ascii")[:256]


# ── errors and the mandatory response shape ───────────────────────────────────

_OUTCOME_BY_STATUS = {
    400: "bad_request",
    413: "bad_request",
    450: "out_of_sync",
    451: "rejected",
    500: "error",
    503: "disabled",
}


class HovtpError(Exception):
    """Any refusal. Carries everything `hovtp_response` needs to answer."""

    def __init__(self, status: int, reason: str, last_serial: int = 0, outcome: str | None = None):
        super().__init__(f"{status} {reason}")
        self.status = status
        self.reason = reason
        self.last_serial = last_serial
        self.outcome = outcome or _OUTCOME_BY_STATUS.get(status, "error")


def hovtp_response(status: int, last_serial: int = 0, reason: str | None = None) -> func.HttpResponse:
    """
    The ONE place a HOVTP response is built. Spec §6: every response — 200 and
    every failure alike — carries the environment, the last accepted serial and
    (optionally) the keep-alive interval, so the sender can resynchronise from
    any answer it gets.
    """
    headers = {
        "Cache-Control": "no-cache",
        "X-HOVTP-Environment": _environment(),
        "X-HOVTP-Last-Serial-Number": str(int(last_serial or 0)),
    }
    keep_alive = _keep_alive()
    if keep_alive > 0:
        headers["X-HOVTP-Keep-Alive-Interval"] = str(keep_alive)
    if reason:
        headers["X-HOVTP-Error-Reason"] = _ascii_metadata(reason)

    return func.HttpResponse(
        (reason or "") + ("\n" if reason else ""),
        status_code=status,
        headers=headers,
        mimetype="text/plain",
    )


def log_message(record: dict) -> None:
    """One structured line per request. Never a body, never every header."""
    logging.info("hovtp " + json.dumps(record, sort_keys=True, default=str))


# ── request parsing ───────────────────────────────────────────────────────────

@dataclass
class HovtpHeaders:
    session_id: str = ""
    serial: int | None = None
    origin: str = ""
    environment: str = ""
    venue: str = ""
    discipline: str = ""
    data_type: str = "ODF"
    data_layer: dict = field(default_factory=dict)


def parse_hovtp_headers(headers) -> HovtpHeaders:
    """
    Spec §5. `req.headers` is already case-insensitive and order-independent,
    so nothing here depends on how FSM spells or orders the header names.

    Session-Id and Serial-Number travel together: one without the other is a
    protocol error (400). Both absent is tolerated — the real captures show FSM
    installations that send neither — and answered with Last-Serial 0.
    """
    session_raw = (headers.get("X-HOVTP-Session-Id") or "").strip()
    serial_raw = (headers.get("X-HOVTP-Serial-Number") or "").strip()

    if session_raw and not serial_raw:
        raise HovtpError(400, "serial number missing")
    if serial_raw and not session_raw:
        raise HovtpError(400, "session id missing")

    session_id = ""
    serial = None
    if session_raw:
        try:
            session_id = str(uuid.UUID(session_raw))
        except (ValueError, AttributeError, TypeError):
            raise HovtpError(400, "invalid session id")

        if not serial_raw.isdigit():
            raise HovtpError(400, "invalid serial number")
        serial = int(serial_raw)
        if serial < 1 or serial > MAX_SERIAL:
            raise HovtpError(400, "invalid serial number")

    data_layer = {}
    for key, value in headers.items():
        lower = key.lower()
        if not lower.startswith("x-"):
            continue
        if lower.startswith(_INFRA_HEADER_PREFIXES):
            continue
        data_layer[lower] = value

    return HovtpHeaders(
        session_id=session_id,
        serial=serial,
        origin=(headers.get("X-HOVTP-Origin") or "").strip(),
        environment=(headers.get("X-HOVTP-Environment") or "").strip(),
        venue=(headers.get("X-HOVTP-Venue") or "").strip(),
        discipline=(headers.get("X-HOVTP-Discipline") or "").strip(),
        data_type=(headers.get("X-HOVTP-Data-Type") or "ODF").strip() or "ODF",
        data_layer=data_layer,
    )


def _strip_port(value: str) -> str:
    """`1.2.3.4:5678` / `[::1]:5678` -> the address. Bare IPv6 is left alone."""
    value = value.strip()
    if value.startswith("["):
        end = value.find("]")
        if end > 0:
            return value[1:end]
        return value.lstrip("[")
    if value.count(":") == 1:
        return value.split(":", 1)[0]
    return value


def _canonical_ip(value: str) -> str:
    """Canonical text form, or '' when it isn't an address. Scope id dropped."""
    candidate = _strip_port(value)
    if "%" in candidate:
        candidate = candidate.split("%", 1)[0]
    if not candidate:
        return ""
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return ""


def client_ip(headers, hops: int = 0) -> str:
    """
    The source identity. App Service *appends* the socket peer to
    X-Forwarded-For, so the trustworthy entry is the LAST one; each additional
    reverse proxy we own (APIM, Front Door — see the plan) shifts that one step
    left, which is what HOVTP_TRUSTED_PROXY_HOPS counts.
    """
    forwarded = headers.get("X-Forwarded-For") or ""
    entries = [part.strip() for part in forwarded.split(",") if part.strip()]
    if entries:
        index = -(1 + hops)
        candidate = entries[index] if abs(index) <= len(entries) else entries[0]
        ip = _canonical_ip(candidate)
        if ip:
            return ip

    for fallback in ("X-Client-IP", "X-Azure-ClientIP"):
        ip = _canonical_ip(headers.get(fallback) or "")
        if ip:
            return ip

    raise HovtpError(500, "client address unavailable")


@dataclass
class OdfMessage:
    attrs: dict = field(default_factory=dict)
    report_title: str = ""
    pdf_b64: str = ""

    @property
    def document_type(self) -> str:
        return (self.attrs.get("DocumentType") or "").strip().upper()

    @property
    def document_code(self) -> str:
        return (self.attrs.get("DocumentCode") or "").strip()

    @property
    def document_subtype(self) -> str:
        return (self.attrs.get("DocumentSubtype") or "").strip()

    @property
    def document_subcode(self) -> str:
        return (self.attrs.get("DocumentSubcode") or "").strip()


def _local_name(tag) -> str:
    """Namespace-insensitive tag name — FSM may or may not declare one."""
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1]


def parse_odf(body: bytes) -> OdfMessage:
    """
    Streamed, and stops as early as it can: for everything but DT_PDF the very
    first start tag (`OdfBody` and its attributes) is all we need — the body is
    stored verbatim anyway. DT_PDF continues only as far as REPORT_TITLE and
    the base64 payload.
    """
    message = OdfMessage()
    seen_root = False
    want_pdf = False

    try:
        for event, element in ET.iterparse(io.BytesIO(body), events=("start", "end")):
            name = _local_name(element.tag)

            if event == "start":
                if seen_root:
                    continue
                if name != "OdfBody":
                    raise HovtpError(400, "body is not an ODF message")
                seen_root = True
                message.attrs = {_local_name(key): value for key, value in element.attrib.items()}
                want_pdf = message.document_type == DT_PDF
                if not want_pdf:
                    break
                continue

            if name == "ExtendedInfo" and (element.get("Code") or "") == "REPORT_TITLE":
                message.report_title = (element.get("Value") or "").strip()
            elif name == "PDFData":
                message.pdf_b64 = (element.text or "").strip()
                break
            else:
                element.clear()
    except ET.ParseError:
        raise HovtpError(400, "body is not valid XML")

    if not seen_root:
        raise HovtpError(400, "body is not an ODF message")

    return message


def resolve_code(route_code: str, message: OdfMessage, headers) -> str:
    """Path wins (the operator typed it into FSM), then the body, then a header."""
    if (route_code or "").strip():
        return route_code.strip()

    from_body = (message.attrs.get("CompetitionCode") or "").strip()
    if from_body:
        return from_body

    for key in sorted(headers.keys()):
        lower = key.lower()
        if lower.startswith("x-") and "competition" in lower:
            value = (headers.get(key) or "").strip()
            if value:
                return value

    raise HovtpError(451, "no competition code in message")


def lookup_competition(table_client, code: str) -> tuple[str, str]:
    """(normalized code, competition guid). 451 on unknown or deleted."""
    normalized = normalize_code(code)
    if not normalized:
        raise HovtpError(451, "no competition code in message")

    try:
        code_row = table_client.get_entity(partition_key=PK_CODE, row_key=normalized)
    except ResourceNotFoundError:
        raise HovtpError(451, f"unknown competition code {normalized}", outcome="unknown_code")

    competition_id = (code_row.get("CompetitionId") or "").strip()
    if not competition_id:
        raise HovtpError(451, f"unknown competition code {normalized}", outcome="unknown_code")

    try:
        competition = table_client.get_entity(partition_key=PK_COMPETITION, row_key=competition_id)
    except ResourceNotFoundError:
        raise HovtpError(451, f"unknown competition code {normalized}", outcome="unknown_code")

    if competition.get("Status") == STATUS_DELETED:
        raise HovtpError(451, f"competition {normalized} is deleted", outcome="unknown_code")

    return normalized, competition_id


# ── sessions (serial numbers) ─────────────────────────────────────────────────

def read_session(table_client, session_id: str):
    """The session row, or None. Read-only — OPTIONS uses this too."""
    if not session_id:
        return None
    try:
        return table_client.get_entity(partition_key=PK_HOVTP_SESSION, row_key=session_id)
    except ResourceNotFoundError:
        return None


def _entity_etag(entity) -> str:
    metadata = getattr(entity, "metadata", None)
    if isinstance(metadata, dict) and metadata.get("etag"):
        return metadata["etag"]
    if isinstance(entity, dict):
        return entity.get("etag") or entity.get("odata.etag") or ""
    return ""


def decide_serial(last_serial: int, serial: int | None, strict: bool) -> tuple[int, str]:
    """
    Spec §6.2, read-only: (last accepted serial to report, warning or '').
    Serial 1 always resets the session — that is how FSM restarts a feed.
    """
    if serial is None:
        return 0, ""
    if serial == 1:
        return last_serial, "session reset" if last_serial else ""
    if serial <= last_serial:
        raise HovtpError(
            450,
            f"duplicate serial {serial}, last accepted {last_serial}",
            last_serial=last_serial,
        )
    if serial > last_serial + 1:
        if strict:
            raise HovtpError(
                450,
                f"serial gap, expected {last_serial + 1}",
                last_serial=last_serial,
            )
        return last_serial, f"serial gap, expected {last_serial + 1}, got {serial}"
    return last_serial, ""


def commit_serial(table_client, session_id: str, serial: int | None, ip: str, now: str) -> int:
    """
    Persist the accepted serial, etag-conditional so two concurrent posts on one
    session can't lose an update. Called only AFTER the blobs are stored: a
    failed store must let FSM resend without meeting a false 450.
    """
    if not session_id or serial is None:
        return 0

    for attempt in range(SERIAL_COMMIT_RETRIES):
        existing = read_session(table_client, session_id)
        try:
            if existing is None:
                table_client.create_entity({
                    "PartitionKey": PK_HOVTP_SESSION,
                    "RowKey": session_id,
                    "LastSerial": serial,
                    "Ip": ip,
                    "CreatedUtc": now,
                    "UpdatedUtc": now,
                })
            else:
                table_client.update_entity(
                    {
                        "PartitionKey": PK_HOVTP_SESSION,
                        "RowKey": session_id,
                        "LastSerial": serial,
                        "Ip": ip,
                        "UpdatedUtc": now,
                    },
                    mode=UpdateMode.MERGE,
                    etag=_entity_etag(existing),
                    match_condition=MatchConditions.IfNotModified,
                )
            return serial
        except (ResourceModifiedError, ResourceExistsError) as e:
            logging.warning(
                f"HOVTP session '{session_id}' changed under us "
                f"(attempt {attempt + 1}/{SERIAL_COMMIT_RETRIES}): {e}"
            )

    logging.error(f"Could not commit serial {serial} for HOVTP session '{session_id}'")
    return serial


# ── sources (per-IP trust) ────────────────────────────────────────────────────

def load_source(table_client, competition_id: str, ip: str):
    try:
        return table_client.get_entity(
            partition_key=PK_HOVTP_SOURCE,
            row_key=source_row_key(competition_id, ip),
        )
    except ResourceNotFoundError:
        return None


def source_state(entity, now: str) -> str:
    """
    'accepted' only while the acceptance window is open. An expired acceptance
    falls back to 'pending' so the UI re-prompts instead of silently trusting a
    week-old decision.
    """
    if entity is None:
        return SOURCE_PENDING
    status = (entity.get("Status") or SOURCE_PENDING).strip().lower()
    if status == SOURCE_REJECTED:
        return SOURCE_REJECTED
    if status == SOURCE_ACCEPTED and (entity.get("AcceptedUntilUtc") or "") > now:
        return SOURCE_ACCEPTED
    return SOURCE_PENDING


def count_pending_sources(table_client, competition_id: str, now: str) -> set[str]:
    """The IPs currently quarantined for this competition (RowKey range scan)."""
    # RowKey is '<guid>_<ip>'; '`' is the character right after '_'.
    query = (
        f"PartitionKey eq '{PK_HOVTP_SOURCE}' "
        f"and RowKey ge '{competition_id}_' and RowKey lt '{competition_id}`'"
    )
    pending = set()
    try:
        for row in table_client.query_entities(query):
            if source_state(row, now) == SOURCE_PENDING:
                pending.add(row.get("Ip") or "")
    except Exception as e:
        logging.warning(f"Could not count pending HOVTP sources for '{competition_id}': {e}")
    pending.discard("")
    return pending


def upsert_source(table_client, competition_id: str, ip: str, hdr: HovtpHeaders, now: str,
                  existing, *, status: str | None = None, pending_files: int = 0,
                  pending_bytes: int = 0, document_type: str = "",
                  counters: bool = True) -> None:
    """
    Merge-upsert the trust row. `counters=False` is the "just record that we
    heard from this IP" path (a rejected source, or a dropped document type):
    it must not touch Status or the quarantine counters.
    """
    entity = {
        "PartitionKey": PK_HOVTP_SOURCE,
        "RowKey": source_row_key(competition_id, ip),
        "LastSeenUtc": now,
        "UpdatedUtc": now,
    }

    if existing is None:
        entity.update({
            "CompetitionId": competition_id,
            "Ip": ip,
            "FirstSeenUtc": now,
            "MessageCount": 1,
            "PendingCount": int(pending_files),
            "PendingBytes": int(pending_bytes),
            "Status": status or SOURCE_PENDING,
            "AcceptedUntilUtc": "",
            "AcceptedBy": "",
            "AcceptedUtc": "",
            "RejectedBy": "",
            "RejectedUtc": "",
        })
    else:
        entity["MessageCount"] = int(existing.get("MessageCount") or 0) + 1
        if counters:
            entity["PendingCount"] = int(existing.get("PendingCount") or 0) + int(pending_files)
            entity["PendingBytes"] = int(existing.get("PendingBytes") or 0) + int(pending_bytes)
            if status:
                entity["Status"] = status

    if counters or existing is None:
        entity.update({
            "Origin": hdr.origin,
            "Venue": hdr.venue,
            "Discipline": hdr.discipline,
            "Environment": hdr.environment,
            "LastDataType": hdr.data_type,
        })

    if document_type:
        entity["LastDocumentType"] = document_type

    table_client.upsert_entity(entity, mode=UpdateMode.MERGE)


# ── file derivation ───────────────────────────────────────────────────────────

def _slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", str(value or "")).strip("_")


def _join_nonempty(parts) -> str:
    return "_".join(part for part in parts if part)


@dataclass
class DerivedFile:
    name: str
    data: bytes
    content_type: str


def derive_files(message: OdfMessage, hdr: HovtpHeaders, body: bytes,
                 serial: int | None) -> list[DerivedFile]:
    """
    What actually lands in the pool. For DT_PDF that is the decoded PDF only —
    the ODF envelope is a transport detail nobody wants in the file list.
    Everything else is stored as the raw XML it arrived as.
    """
    if message.document_type == DT_PDF:
        if not message.pdf_b64:
            raise HovtpError(451, "DT_PDF without PDFData")
        try:
            data = base64.b64decode(re.sub(r"\s+", "", message.pdf_b64), validate=True)
        except (binascii.Error, ValueError):
            raise HovtpError(451, "PDFData is not valid base64")
        if not data.startswith(b"%PDF"):
            raise HovtpError(451, "PDFData is not a PDF")

        raw_name = _join_nonempty([
            message.document_code.rstrip("-"),
            message.document_subtype,
            _slug(message.report_title),
        ]) + ".pdf"
        return [DerivedFile(_checked_name(raw_name), data, "application/pdf")]

    raw_name = _join_nonempty([
        message.document_type,
        message.document_code,
        message.document_subcode,
    ])
    if message.document_type.endswith("_UPDATE"):
        # Increments must not overwrite each other; bulk messages must.
        stamp = (message.attrs.get("LogicalDate") or "").replace("-", "") + \
                (message.attrs.get("Time") or "")
        raw_name = f"{raw_name}_{stamp or serial or ''}".rstrip("_")
    raw_name += ".xml"

    return [DerivedFile(_checked_name(raw_name), bytes(body), "application/xml")]


def _checked_name(raw_name: str) -> str:
    name, error = sanitize_pool_filename(raw_name)
    if error:
        raise HovtpError(451, "unusable document name")
    return name


def build_metadata(message: OdfMessage, hdr: HovtpHeaders, ip: str, now: str) -> dict:
    """
    Blob metadata rides in HTTP headers: ASCII only, legal C-identifier keys,
    and a hard cap (Azure allows 8 KiB of metadata — we stop well short) so a
    chatty sender can never make an upload unstorable.
    """
    metadata = {
        "source": "hovtp",
        "sourceTool": "hovtp",
        "uploadedBy": _ascii_metadata(f"hovtp:{ip}"),
        "hovtpIp": _ascii_metadata(ip),
        "hovtpOrigin": _ascii_metadata(hdr.origin),
        "hovtpSessionId": _ascii_metadata(hdr.session_id),
        "hovtpSerial": _ascii_metadata("" if hdr.serial is None else hdr.serial),
        "hovtpDataType": _ascii_metadata(hdr.data_type),
        "hovtpEnvironment": _ascii_metadata(hdr.environment),
        "hovtpVenue": _ascii_metadata(hdr.venue),
        "hovtpDiscipline": _ascii_metadata(hdr.discipline),
        "receivedUtc": now,
    }

    extras: list[tuple[str, str]] = []
    for key in sorted(message.attrs):
        extras.append((f"odf_{key.lower()}", _ascii_metadata(message.attrs[key])))
    if message.report_title:
        extras.append(("report_title", _ascii_metadata(message.report_title)))
    for key in sorted(hdr.data_layer):
        extras.append((key.replace("-", "_"), _ascii_metadata(hdr.data_layer[key])))

    used = sum(len(k) + len(v) for k, v in metadata.items())
    added = 0
    for key, value in extras:
        if added >= MAX_EXTRA_METADATA_KEYS:
            break
        if key in metadata or not _METADATA_KEY_RE.match(key):
            continue
        cost = len(key) + len(value)
        if used + cost > MAX_METADATA_BYTES:
            continue
        metadata[key] = value
        used += cost
        added += 1

    return metadata


# ── handlers ──────────────────────────────────────────────────────────────────
# The @app.route entry point below is a thin adapter; all logic lives in these
# plain functions so the test suite can drive them without the Functions host.

def _hovtp_options(req: func.HttpRequest, record: dict) -> func.HttpResponse:
    """
    Spec §4.3: status / keep-alive probe. MUST have no side effects, so this
    only ever reads — no table row is created, no blob is written.
    """
    if not _enabled():
        raise HovtpError(503, "receiver disabled")

    hdr = parse_hovtp_headers(req.headers)
    record.update({
        "origin": hdr.origin,
        "environment": hdr.environment,
        "session": hdr.session_id,
        "serial": hdr.serial,
    })

    last_serial = 0
    if hdr.session_id:
        table_client = get_table_client()
        if table_client is None:
            raise HovtpError(500, "storage unavailable")
        session = read_session(table_client, hdr.session_id)
        if session is not None:
            last_serial = int(session.get("LastSerial") or 0)

    record.update({"outcome": "ok", "status": 200, "lastSerial": last_serial})
    return hovtp_response(200, last_serial)


def _hovtp_post(req: func.HttpRequest, record: dict) -> func.HttpResponse:
    if not _enabled():
        raise HovtpError(503, "receiver disabled")

    # Refuse an oversized message from its declared length, before the body is
    # materialised. The real check is on the bytes below.
    declared = req.headers.get("Content-Length")
    if declared:
        try:
            if int(declared) > MAX_MESSAGE_SIZE:
                raise HovtpError(413, "message too large")
        except ValueError:
            pass

    hdr = parse_hovtp_headers(req.headers)
    ip = client_ip(req.headers, _trusted_hops())
    record.update({
        "ip": ip,
        "origin": hdr.origin,
        "environment": hdr.environment,
        "session": hdr.session_id,
        "serial": hdr.serial,
    })

    body = req.get_body() or b""
    record["bytes"] = len(body)
    if not body:
        raise HovtpError(400, "empty body")
    if len(body) > MAX_MESSAGE_SIZE:
        raise HovtpError(413, "message too large")

    message = parse_odf(body)
    record.update({
        "documentType": message.document_type,
        "documentCode": message.document_code,
        "documentSubtype": message.document_subtype,
    })

    table_client = get_table_client()
    if table_client is None:
        raise HovtpError(500, "storage unavailable")

    code = resolve_code(req.route_params.get("code") or "", message, req.headers)
    normalized, competition_id = lookup_competition(table_client, code)
    record.update({"code": normalized, "competitionId": competition_id})

    session = read_session(table_client, hdr.session_id)
    stored_serial = int(session.get("LastSerial") or 0) if session is not None else 0
    _reported, warning = decide_serial(stored_serial, hdr.serial, _strict_serial())
    if warning:
        logging.warning(f"HOVTP session '{hdr.session_id}' from {ip}: {warning}")

    now = _now_utc()
    existing_source = load_source(table_client, competition_id, ip)

    # Not on the allowlist: transport accepted (200, serial committed so FSM
    # keeps streaming), nothing stored, but the source still surfaces in the UI.
    if message.document_type not in _allowed_document_types():
        last_serial = commit_serial(table_client, hdr.session_id, hdr.serial, ip, now)
        upsert_source(table_client, competition_id, ip, hdr, now, existing_source,
                      document_type=message.document_type,
                      counters=existing_source is None)
        record.update({"outcome": "dropped", "status": 200,
                       "lastSerial": last_serial, "blobs": []})
        return hovtp_response(200, last_serial)

    files = derive_files(message, hdr, body, hdr.serial)

    state = source_state(existing_source, now)
    if state == SOURCE_REJECTED:
        last_serial = commit_serial(table_client, hdr.session_id, hdr.serial, ip, now)
        upsert_source(table_client, competition_id, ip, hdr, now, existing_source,
                      counters=False)
        record.update({"outcome": "rejected", "status": 451,
                       "reason": "source not accepted", "lastSerial": last_serial,
                       "blobs": []})
        return hovtp_response(451, last_serial, "source not accepted")

    quarantined = state != SOURCE_ACCEPTED
    total_bytes = sum(len(item.data) for item in files)

    if quarantined:
        pending_files = int((existing_source or {}).get("PendingCount") or 0)
        pending_bytes = int((existing_source or {}).get("PendingBytes") or 0)
        if pending_files + len(files) > MAX_PENDING_FILES or \
                pending_bytes + total_bytes > MAX_PENDING_BYTES:
            raise HovtpError(451, "quarantine full", last_serial=stored_serial, outcome="quota")

        pending_ips = count_pending_sources(table_client, competition_id, now)
        pending_ips.add(ip)
        if len(pending_ips) > MAX_PENDING_SOURCES:
            raise HovtpError(451, "quarantine full", last_serial=stored_serial, outcome="quota")

        prefix = competition_pending_prefix(competition_id, ip)
    else:
        prefix = competition_fsm_prefix(competition_id)

    container = _get_container_client()
    if container is None:
        raise HovtpError(500, "storage unavailable")

    metadata = build_metadata(message, hdr, ip, now)
    stored = []
    for item in files:
        try:
            container.upload_blob(
                name=prefix + item.name,
                data=item.data,
                overwrite=True,
                metadata=dict(metadata),
                content_settings=ContentSettings(content_type=item.content_type),
            )
        except Exception as e:
            logging.error(f"Error storing HOVTP file '{item.name}' for '{competition_id}': {e}")
            raise HovtpError(500, "could not store the message", last_serial=stored_serial)
        stored.append(item.name)

    # Blobs first, serial second: a failed store leaves the serial uncommitted
    # so FSM's resend is accepted rather than answered 450.
    last_serial = commit_serial(table_client, hdr.session_id, hdr.serial, ip, now)
    upsert_source(
        table_client, competition_id, ip, hdr, now, existing_source,
        status=SOURCE_PENDING if quarantined else SOURCE_ACCEPTED,
        pending_files=len(files) if quarantined else 0,
        pending_bytes=total_bytes if quarantined else 0,
        document_type=message.document_type,
    )

    record.update({
        "outcome": "quarantined" if quarantined else "ok",
        "status": 200,
        "lastSerial": last_serial,
        "blobs": stored,
    })
    return hovtp_response(200, last_serial)


def _handle_hovtp(req: func.HttpRequest) -> func.HttpResponse:
    record = {
        "method": req.method,
        "ip": "",
        "origin": "",
        "environment": "",
        "session": "",
        "serial": None,
        "lastSerial": 0,
        "code": "",
        "competitionId": "",
        "documentType": "",
        "documentCode": "",
        "documentSubtype": "",
        "outcome": "error",
        "status": 500,
        "reason": "",
        "bytes": 0,
        "blobs": [],
    }

    try:
        if req.method == "OPTIONS":
            response = _hovtp_options(req, record)
        else:
            response = _hovtp_post(req, record)
    except HovtpError as e:
        record.update({"outcome": e.outcome, "status": e.status,
                       "reason": e.reason, "lastSerial": e.last_serial})
        response = hovtp_response(e.status, e.last_serial, e.reason)
    except Exception as e:
        logging.exception(f"Unhandled HOVTP error: {e}")
        record.update({"outcome": "error", "status": 500, "reason": "internal error"})
        response = hovtp_response(500, 0, "internal error")

    log_message(record)
    return response


# ── HTTP routes ───────────────────────────────────────────────────────────────
# The Functions host prepends the default `api` route prefix, so these register
# as /api/hovtp, /api/hovtp/{code} and /api/health.

@app.route(route="hovtp", auth_level=func.AuthLevel.ANONYMOUS, methods=["POST", "OPTIONS"])
def hovtp(req: func.HttpRequest) -> func.HttpResponse:
    return _handle_hovtp(req)


@app.route(route="hovtp/{code}", auth_level=func.AuthLevel.ANONYMOUS, methods=["POST", "OPTIONS"])
def hovtp_for_code(req: func.HttpRequest) -> func.HttpResponse:
    return _handle_hovtp(req)


@app.route(route="health", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET"])
def health(req: func.HttpRequest) -> func.HttpResponse:
    """Liveness probe. Deliberately touches no storage and needs no identity."""
    return func.HttpResponse(
        json.dumps({"status": "ok", "service": "fs-hovtp"}),
        status_code=200,
        mimetype="application/json",
    )
