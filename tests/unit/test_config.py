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
