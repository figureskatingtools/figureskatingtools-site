# `infra/hovtp` — the FS Manager (HOVTP) listener

A standalone Python Function App (`func-fs-hovtp-<suffix>`, FC1, Python 3.13)
that FS Manager pushes ODF messages and report PDFs to. Accepted files land in
the competition's shared file pool; files from an IP nobody has vouched for are
quarantined until an operator accepts the source on the home page.

It is deliberately **not** part of the platform API (`infra/functions`): this is
the only endpoint on the platform that an unauthenticated stranger can reach, so
it must be switchable off on its own — `HOVTP_ENABLED=false`,
`az functionapp stop`, or revoking its storage RBAC — without taking the site
down with it.

## FSM settings to enter

FSM: **Settings → HOVTP Settings** (§7.3 / §11.4.5 of the FSM manual; one
connection per licence, five with TV/SCB Control).

| Field        | Value                                       |
| ------------ | ------------------------------------------- |
| Name         | anything, e.g. `figureskatingtools`         |
| IP-Address   | `func-fs-hovtp-<suffix>.azurewebsites.net`  |
| Port         | `443`                                       |
| Endpoint     | `/api/v1/hovtp`                             |

The endpoint carries no competition code: the listener takes it from the
message itself (`OdfBody/@CompetitionCode`), so one connection setting serves
every competition and nothing has to be re-typed between events.

Leave FSM's **"Extended ODF"** checkbox as it is (see the note at the bottom).

## Endpoints

```
POST    /api/v1/hovtp              receive a message
OPTIONS /api/v1/hovtp              status / keep-alive probe — no side effects
GET     /api/health                {"status":"ok","service":"fs-hovtp"}
```

### Request headers

All optional, all case-insensitive and order-independent.

| Header                   | Meaning                                                |
| ------------------------ | ------------------------------------------------------ |
| `X-HOVTP-Session-Id`     | UUID. Must be accompanied by a serial number.           |
| `X-HOVTP-Serial-Number`  | uint64, from 1, gap-free per session.                   |
| `X-HOVTP-Origin`         | free text, recorded on the source row and the blob.     |
| `X-HOVTP-Environment`    | `Production` / `Test`. **Never** a reason to refuse.    |
| `X-HOVTP-Venue`          | free text.                                              |
| `X-HOVTP-Discipline`     | free text.                                              |
| `X-HOVTP-Data-Type`      | defaults to `ODF`.                                      |
| `X-<DataType>-*`         | data-layer headers; recorded as blob metadata.          |

Session-Id and Serial-Number travel together: one without the other is `400`.
Both absent is tolerated (the real captures show installs that send neither) —
the message is stored and the response reports last-serial `0`.

### Response headers

Every response — `200` and every failure alike — carries:

```
Cache-Control:               no-cache
X-HOVTP-Environment:         our environment (HOVTP_ENVIRONMENT), echoed
X-HOVTP-Last-Serial-Number:  last accepted serial for the session, 0 if none
X-HOVTP-Keep-Alive-Interval: seconds, omitted when HOVTP_KEEP_ALIVE_SECONDS = 0
X-HOVTP-Error-Reason:        human text, on failures only
```

### Status codes

| Code  | When                                                                        |
| ----- | --------------------------------------------------------------------------- |
| `200` | stored, quarantined, or deliberately dropped (document type off the allowlist) |
| `400` | body empty / not XML / root is not `OdfBody`; malformed session or serial     |
| `413` | over 50 MiB (checked from `Content-Length` first, then from the bytes)        |
| `450` | out of synchro: duplicate serial, or a gap while `HOVTP_STRICT_SERIAL=true`   |
| `451` | data-layer error: unknown/deleted competition, rejected source, quarantine full, unusable PDF payload or filename |
| `500` | client address unavailable, storage unavailable, storage write failed         |
| `503` | `HOVTP_ENABLED=false`                                                         |

A serial gap is a **warning**, not a refusal, by default: the sender gives up
after ten consecutive `450`s, and losing the feed is worse than a hole in it.
Serial `1` always resets the session — that is how FSM restarts a feed.

Ordering guarantees: blobs are written **before** the serial is committed (a
failed store must let FSM resend rather than meet a false duplicate); `451`
outcomes still commit the serial (the message will never be valid, so resending
it is pointless); `400`, `450`, `500` and `503` write nothing at all.

## Document-type allowlist

Only these are stored (override with `HOVTP_ALLOWED_DOCUMENT_TYPES`):

```
DT_PDF, DT_PARTIC, DT_PARTIC_TEAMS, DT_SCHEDULE, DT_SCHEDULE_UPDATE
```

Everything else — `DT_RESULT` above all, which FSM re-sends after every single
skater — is answered `200`, logged with `outcome=dropped` and written nowhere.
The serial is still committed so the feed keeps flowing, and the source's trust
row is still touched, so an IP whose very first message is a result still
surfaces in the UI for the operator to accept.

### File names

* `DT_PDF` — the base64 in `<PDFData>` is decoded (it must start with `%PDF`)
  and stored **on its own**; the ODF wrapper is not kept. The name mirrors FS
  Manager's own PDF export exactly — `<DocumentCode as sent, padding dashes
  included>_<REPORT_TITLE with everything but letters and digits removed>.pdf`
  — because Judge Papers recognises category, segment and sheet type from that
  shape: `FSKWSINGLES-DEBYTW----FNL-000100--_StartListwithTimes.pdf`,
  `FSKWSINGLES-DEBYTW----------------_CalculationSetupVerificationforReferee.pdf`,
  `FSK-------------------------------_CompetitionSchedule.pdf`. Without a
  REPORT_TITLE the DocumentSubtype (`C08`) stands in for the title.
* everything else — the raw request body as
  `<DocumentType>_<DocumentCode>[_<DocumentSubcode>].xml`. A `*_UPDATE` type
  gets `_<LogicalDate><Time>` appended (serial as a fallback) so increments do
  not overwrite each other; bulk messages deliberately do overwrite.

Every name goes through the platform's `sanitize_pool_filename`; a name that
survives it as nothing usable is `451`.

## Trust model

Source identity is the client IP (`X-Forwarded-For`, last entry minus
`HOVTP_TRUSTED_PROXY_HOPS` — App Service *appends* the socket peer — then
`X-Client-IP`, then `X-Azure-ClientIP`). FSM sends no credentials, so:

| Source state                        | What happens                                             |
| ----------------------------------- | -------------------------------------------------------- |
| unknown, pending, or expired accept | quarantined under `<guid>/fsm-pending/<ip>/`, row `pending`, `200` |
| accepted and inside its window      | stored flat under `<guid>/fsm/`, `200`                    |
| rejected                            | `451 source not accepted`; only `LastSeenUtc`/`MessageCount` move |

Nothing is ever dropped for being unknown — the operator accepts the source in
the UI (1/2/3/7 days) and the quarantined files are attached to the pool.
An acceptance that has expired flips back to `pending` so the UI re-prompts
instead of trusting a week-old decision.

Quarantine quotas, all answered `451 quarantine full`: **200 files** and
**200 MiB** per source, **20 pending sources** per competition.

## Storage

Both live in the platform's storage account, shared with `infra/functions`.

Table `competitions` — two row kinds owned by this app:

```
PartitionKey="HOVTPSOURCE", RowKey="<guid>_<ip>"
    CompetitionId, Ip, Origin, Venue, Discipline, Environment,
    Status (pending|accepted|rejected), FirstSeenUtc, LastSeenUtc,
    MessageCount, PendingCount, PendingBytes,
    AcceptedUntilUtc, AcceptedBy, AcceptedUtc, RejectedBy, RejectedUtc,
    UpdatedUtc, LastDataType, LastDocumentType

PartitionKey="HOVTPSESSION", RowKey="<uuid>"
    LastSerial, Ip, CreatedUtc, UpdatedUtc
```

and it reads the platform's `CODE` / `COMPETITION` rows to turn a competition
code into a GUID. Timestamps are `%Y-%m-%dT%H:%M:%SZ`.

Container `competition-data` (`COMPETITION_DATA_CONTAINER`):

```
<guid>/fsm/<name>                 accepted — FLAT, the pool listing skips nested names
<guid>/fsm-pending/<ip>/<name>    quarantined — invisible to the pool until attached
```

Blob metadata on every stored file (ASCII, legal C-identifier keys, at most 24
extra keys and 6 KiB in total):

```
source=hovtp  sourceTool=hovtp  uploadedBy=hovtp:<ip>
hovtpIp  hovtpOrigin  hovtpSessionId  hovtpSerial  hovtpDataType
hovtpEnvironment  hovtpVenue  hovtpDiscipline  receivedUtc
odf_<attribute lowercased>   for every OdfBody attribute
report_title                 for DT_PDF
x_<header with '-' as '_'>   for every non-infrastructure X-* request header
```

`normalize_code` and the storage helpers are **verbatim copies** of
`infra/functions/function_app.py` (marked `KEEP IN SYNC`); `tests/test_parity.py`
fails if either side drifts.

## Settings

Read on every call, so an app-setting change takes effect without a restart.

| Setting                        | Default                                                | Meaning |
| ------------------------------ | ------------------------------------------------------ | ------- |
| `HOVTP_ENABLED`                | `true`                                                 | kill switch; `0`/`false`/`no` ⇒ every request `503` |
| `HOVTP_ENVIRONMENT`            | `Test`                                                 | echoed in `X-HOVTP-Environment` |
| `HOVTP_STRICT_SERIAL`          | `false`                                                | `true` ⇒ a serial gap is `450` instead of a warning |
| `HOVTP_KEEP_ALIVE_SECONDS`     | `60`                                                   | `0` omits `X-HOVTP-Keep-Alive-Interval` |
| `HOVTP_TRUSTED_PROXY_HOPS`     | `0`                                                    | reverse proxies we own in front of App Service |
| `HOVTP_ALLOWED_DOCUMENT_TYPES` | `DT_PDF,DT_PARTIC,DT_PARTIC_TEAMS,DT_SCHEDULE,DT_SCHEDULE_UPDATE` | comma list |
| `COMPETITION_DATA_CONTAINER`   | `competition-data`                                     | read at import, like the platform app |
| `AzureWebJobsStorage__accountName` / `AzureWebJobsStorage` | —                          | managed identity, or a connection string locally |

## Local development

```bash
cp local.settings.example.json local.settings.json   # gitignored
func start                                            # with Azurite running

# tests
cd infra/hovtp
uv run --with-requirements requirements.txt \
  --with-requirements requirements-dev.txt python -m pytest tests -q
```

Do not add a `Host.CORS` entry to `local.settings.json`: the Functions host
answers `OPTIONS` itself as a CORS preflight when CORS is configured, and the
probe would then never reach the function.

## Logging

One structured line per request, `logging.info("hovtp " + <json>)`, with
`method, ip, origin, environment, session, serial, lastSerial, code,
competitionId, documentType, documentCode, documentSubtype, outcome, status,
reason, bytes, blobs`. `outcome` is one of `ok | quarantined | dropped |
rejected | out_of_sync | bad_request | unknown_code | quota | disabled | error`.
Bodies and full header dumps are never logged.

## Three things to confirm at runtime

The Functions host sits between FSM and this code, and three of its behaviours
could not be settled from the manuals or from local tests. Check them in App
Insights right after the first real FSM session:

1. **`OPTIONS` reaches the function.** The app is deployed with
   `cors.allowedOrigins: []`, which should leave `OPTIONS` alone — but if the
   host answers the preflight itself, FSM's keep-alive probe never gets our
   `X-HOVTP-Last-Serial-Number` and the sender may treat the link as down.
2. **`450` and `451` pass through unchanged.** They are non-standard codes; if
   the host or any proxy in front of it rewrites them (to `500`, say), FSM's
   out-of-synchro recovery never triggers.
3. **The `X-Forwarded-For` format is what we assume** — the FSM VM's public IP
   as the *last* entry. If a proxy is added later (APIM, Front Door), raise
   `HOVTP_TRUSTED_PROXY_HOPS` to match, or every message will be attributed to
   the proxy instead of to FSM.

The logged `ip` field answers 3 directly; the workflow's post-deploy smoke step
(`OPTIONS` expecting `200` and `x-hovtp-last-serial-number: 0`) answers 1.
