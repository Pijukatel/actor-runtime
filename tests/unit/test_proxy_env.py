"""Apify Proxy environment passthrough: every Actor container gets the
platform's APIFY_PROXY_HOSTNAME / APIFY_PROXY_PORT / APIFY_PROXY_STATUS_URL
connection facts, and APIFY_PROXY_PASSWORD exactly when (and only when) the
user gave the runtime one -- see ``Service._build_environment`` and
``Settings``'s proxy fields. Driven through the real API with the stub
driver, whose ``captured_envs`` records what would reach the container.
"""
from __future__ import annotations

import json

from tests.conftest import PROXY_TEST_SETTINGS


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _provision_and_run(client, service, token="local-user"):
    """Push, build and run a minimal Actor; return the captured container env."""
    await client.post(
        "/v2/acts",
        json={"name": "proxy-env-actor", "versions": [{"versionNumber": "0.0", "buildTag": "latest"}]},
        headers=auth(token),
    )
    actor_id = f"{token}~proxy-env-actor"
    await client.post(
        f"/v2/actors/{actor_id}/versions",
        json={
            "versionNumber": "0.0",
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [{"name": "main.py", "format": "TEXT", "content": "print('hi')\n"}],
        },
        headers=auth(token),
    )
    await client.post(f"/v2/acts/{actor_id}/builds?version=0.0", headers=auth(token))
    await service.wait_idle()
    await client.post(
        f"/v2/acts/{actor_id}/runs",
        content=json.dumps({}),
        headers={**auth(token), "content-type": "application/json"},
    )
    await service.wait_idle()
    return service.driver.captured_envs[-1]


async def test_default_settings_omit_password_but_keep_connection_facts(wired):
    """With no user-supplied password (the default), the platform's proxy
    connection vars are still present -- so an SDK in the container builds the
    same proxy.apify.com:8000 URLs as on the platform -- but
    APIFY_PROXY_PASSWORD is absent entirely (NOT set to an empty string,
    which would make the SDK build URLs with a blank password instead of
    raising its clear missing-password error)."""
    client, service = wired
    env = await _provision_and_run(client, service)
    assert env["APIFY_PROXY_HOSTNAME"] == "proxy.apify.com"
    assert env["APIFY_PROXY_PORT"] == "8000"
    assert env["APIFY_PROXY_STATUS_URL"] == "http://proxy.apify.com"
    assert "APIFY_PROXY_PASSWORD" not in env


async def test_configured_proxy_settings_reach_container_env(wired_proxy):
    """A user-supplied password (and any hostname/port/status overrides)
    reaches every Actor container's env verbatim, platform-style."""
    client, service = wired_proxy
    env = await _provision_and_run(client, service)
    assert env["APIFY_PROXY_PASSWORD"] == PROXY_TEST_SETTINGS["proxy_password"]
    assert env["APIFY_PROXY_HOSTNAME"] == PROXY_TEST_SETTINGS["proxy_hostname"]
    assert env["APIFY_PROXY_PORT"] == str(PROXY_TEST_SETTINGS["proxy_port"])
    assert env["APIFY_PROXY_STATUS_URL"] == PROXY_TEST_SETTINGS["proxy_status_url"]
