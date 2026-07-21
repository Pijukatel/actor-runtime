"""Ports are hardcoded: ``load_settings()`` always resolves 3333/3000, ignoring
``PORT_API``/``PORT_CONSOLE`` in the environment (the override mechanism is
removed, not just re-defaulted).

Apify Proxy settings are the opposite -- read from the environment
(``APIFY_PROXY_PASSWORD`` is exactly the variable the user populates on the
runtime container with their own proxy password), with platform-parity
defaults for everything else.
"""
from __future__ import annotations

from app.config import load_settings


def test_load_settings_defaults_to_fixed_ports(monkeypatch):
    monkeypatch.delenv("PORT_API", raising=False)
    monkeypatch.delenv("PORT_CONSOLE", raising=False)
    settings = load_settings()
    assert settings.port_api == 3333
    assert settings.port_console == 3000


def test_load_settings_ignores_port_env_overrides(monkeypatch):
    monkeypatch.setenv("PORT_API", "9999")
    monkeypatch.setenv("PORT_CONSOLE", "9998")
    settings = load_settings()
    assert settings.port_api == 3333
    assert settings.port_console == 3000


def _clear_proxy_env(monkeypatch):
    for var in (
        "APIFY_PROXY_PASSWORD",
        "APIFY_PROXY_HOSTNAME",
        "APIFY_PROXY_PORT",
        "APIFY_PROXY_STATUS_URL",
    ):
        monkeypatch.delenv(var, raising=False)


def test_load_settings_proxy_defaults(monkeypatch):
    """No proxy env at all: platform-parity connection defaults, no password."""
    _clear_proxy_env(monkeypatch)
    settings = load_settings()
    assert settings.proxy_password is None
    assert settings.proxy_hostname == "proxy.apify.com"
    assert settings.proxy_port == 8000
    assert settings.proxy_status_url == "http://proxy.apify.com"


def test_load_settings_reads_proxy_env(monkeypatch):
    _clear_proxy_env(monkeypatch)
    monkeypatch.setenv("APIFY_PROXY_PASSWORD", "user-supplied-pw")
    monkeypatch.setenv("APIFY_PROXY_HOSTNAME", "proxy.example.com")
    monkeypatch.setenv("APIFY_PROXY_PORT", "9000")
    settings = load_settings()
    assert settings.proxy_password == "user-supplied-pw"
    assert settings.proxy_hostname == "proxy.example.com"
    assert settings.proxy_port == 9000
    # The status URL default follows an overridden hostname (matching the
    # platform, where the status page lives on the proxy hostname itself)...
    assert settings.proxy_status_url == "http://proxy.example.com"
    # ...unless explicitly overridden itself.
    monkeypatch.setenv("APIFY_PROXY_STATUS_URL", "http://status.example.com")
    assert load_settings().proxy_status_url == "http://status.example.com"


def test_load_settings_proxy_password_empty_string_means_absent(monkeypatch):
    """An empty APIFY_PROXY_PASSWORD counts as "not provided": forwarding an
    empty string to Actor containers would make the SDK build proxy URLs with
    a blank password instead of raising its clear missing-password error."""
    _clear_proxy_env(monkeypatch)
    monkeypatch.setenv("APIFY_PROXY_PASSWORD", "")
    assert load_settings().proxy_password is None


def test_load_settings_proxy_port_garbage_falls_back_to_default(monkeypatch):
    _clear_proxy_env(monkeypatch)
    monkeypatch.setenv("APIFY_PROXY_PORT", "not-a-port")
    assert load_settings().proxy_port == 8000
