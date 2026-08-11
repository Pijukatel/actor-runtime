"""Ports are hardcoded: ``load_settings()`` always resolves 3333/3000, ignoring
``PORT_API``/``PORT_CONSOLE`` in the environment (the override mechanism is
removed, not just re-defaulted).
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


def test_load_settings_defaults_apify_proxy_password_to_empty(monkeypatch):
    monkeypatch.delenv("APIFY_PROXY_PASSWORD", raising=False)
    settings = load_settings()
    assert settings.apify_proxy_password == ""


def test_load_settings_reads_apify_proxy_password_env(monkeypatch):
    monkeypatch.setenv("APIFY_PROXY_PASSWORD", "dummy-proxy-password")
    settings = load_settings()
    assert settings.apify_proxy_password == "dummy-proxy-password"


def test_load_settings_defaults_upstream_base_url_to_real_platform(monkeypatch):
    monkeypatch.delenv("APIFY_UPSTREAM_BASE_URL", raising=False)
    settings = load_settings()
    assert settings.apify_upstream_base_url == "https://api.apify.com"


def test_load_settings_upstream_base_url_is_overridable(monkeypatch):
    """Purely so tests (unit and any future e2e) can point the upstream-fallback
    middleware at a local stub instead of the real platform."""
    monkeypatch.setenv("APIFY_UPSTREAM_BASE_URL", "http://127.0.0.1:9")
    settings = load_settings()
    assert settings.apify_upstream_base_url == "http://127.0.0.1:9"


def test_load_settings_strips_trailing_slash_from_upstream_base_url(monkeypatch):
    """Regression: an operator-supplied `APIFY_UPSTREAM_BASE_URL` ending in
    `/` (e.g. `https://api.apify.com/`) produces a double slash once
    `fetch_upstream_fallback` (app/upstream.py) concatenates it with
    `request.url.path` (see requirements/api.md's Upstream fallback
    section). Normalized away by `Settings.__post_init__` -- the boundary
    every construction path goes through -- so `load_settings`, the env-var
    path, never carries a trailing slash through."""
    monkeypatch.setenv("APIFY_UPSTREAM_BASE_URL", "https://api.apify.com/")
    settings = load_settings()
    assert settings.apify_upstream_base_url == "https://api.apify.com"
