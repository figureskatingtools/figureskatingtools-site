"""Liveness probe — the deploy workflow's smoke check calls this."""
import json

import azure.functions as func

import function_app as fa


def _request():
    return func.HttpRequest(method="GET", url="https://func-fs-hovtp.invalid/api/health",
                            headers={}, params={}, route_params={}, body=b"")


def test_health_is_200_and_names_the_service():
    response = fa.health(_request())

    assert response.status_code == 200
    assert json.loads(response.get_body()) == {"status": "ok", "service": "fs-hovtp"}


def test_health_touches_no_storage(monkeypatch):
    def explode(*args, **kwargs):
        raise AssertionError("health must not reach storage")

    monkeypatch.setattr(fa, "get_table_client", explode)
    monkeypatch.setattr(fa, "get_blob_service_client", explode)

    assert fa.health(_request()).status_code == 200
