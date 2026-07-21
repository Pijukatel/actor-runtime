"""Sample Actor demonstrating platform-style proxy input.

Its ``proxyConfiguration`` input is the exact object the platform's proxy
editor (``"editor": "proxy"`` in ``.actor/input_schema.json``) produces, and
it is resolved here the same way ``Actor.create_proxy_configuration`` in the
apify SDK resolves it on the platform:

- ``{"useApifyProxy": true, "apifyProxyGroups": [...], "apifyProxyCountry":
  "XX"}`` builds an Apify Proxy URL from the run's ``APIFY_PROXY_HOSTNAME`` /
  ``APIFY_PROXY_PORT`` / ``APIFY_PROXY_PASSWORD`` environment (all injected by
  the runtime; the password only when the user gave the runtime one -- see the
  repo README's proxy section) with the SDK's username scheme:
  ``groups-<g1>+<g2>,country-<XX>``, or ``auto`` when neither is set. A missing
  password fails the run with the SDK's own clear message, and proxy access is
  then verified against ``APIFY_PROXY_STATUS_URL`` exactly like the SDK does
  (an unreachable status page is only a warning; a reachable one answering
  ``connected: false`` -- e.g. a wrong password -- fails the run).
- ``{"useApifyProxy": false, "proxyUrls": [...]}`` uses the caller's own
  (generic) proxy servers, rotated round-robin like the SDK's ``new_url()``.
- ``useApifyProxy: false`` with no ``proxyUrls`` (or no ``proxyConfiguration``
  at all) resolves to no proxy, exactly like the SDK returning ``None``.

The optional ``targetUrl`` input is then fetched through the resolved proxy
(or directly when none resolved), proving the proxy actually carries traffic;
left empty, the run only resolves and reports the configuration, so it stays
fully offline and deterministic (what the tests use).

Every proxy URL this Actor writes to its OUTPUT/dataset/log has the password
component masked (``***``): the raw INPUT record necessarily holds whatever
the caller sent, but this Actor's own outputs never repeat a credential --
neither the Apify Proxy password nor userinfo from custom ``proxyUrls``.

Deliberately dependency-free (no apify SDK) like ``sample_actor``, so the
image builds offline and the behaviour is fully deterministic; the SDK
semantics above are mirrored in plain stdlib code instead of imported.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

STORAGE = Path(os.environ.get("ACTOR_STORAGE_DIR") or os.environ.get("CRAWLEE_STORAGE_DIR") or "/apify_storage")

# The apify SDK's own validation patterns: proxy group names must match
# APIFY_PROXY_VALUE_REGEX (word chars plus ._~), countries are two-letter
# upper-case ISO codes.
APIFY_PROXY_VALUE_RE = re.compile(r"^[\w._~]+$")
COUNTRY_CODE_RE = re.compile(r"^[A-Z]{2}$")

# The SDK's _check_access numbers: per-attempt timeout and attempt count
# against `{APIFY_PROXY_STATUS_URL}/?format=json`.
ACCESS_CHECK_TIMEOUT_SECS = 10
ACCESS_CHECK_ATTEMPTS = 2
FETCH_TIMEOUT_SECS = 30
FETCH_BODY_PREVIEW_BYTES = 2000


class ProxyConfigurationError(Exception):
    """Invalid proxy input / missing password / failed access check -- fails
    the run with a clear message, mirroring the ValueError/ConnectionError
    ``Actor.create_proxy_configuration`` raises on the platform."""


def default_dir(kind: str) -> Path:
    path = STORAGE / kind / "default"
    path.mkdir(parents=True, exist_ok=True)
    return path


def mask_proxy_url(url: str) -> str:
    """Mask the password component of a proxy URL (``http://u:pass@h:p`` ->
    ``http://u:***@h:p``). The username stays visible: for Apify Proxy it
    encodes only the requested groups/country (the SDK itself logs it), and
    for custom URLs it identifies which server was used. Anything unparseable
    is masked wholesale rather than risking a credential leak."""
    try:
        split = urllib.parse.urlsplit(url)
        if split.password is None:
            return url
        host_port = split.netloc.rsplit("@", 1)[1]
        username = split.username or ""
        return urllib.parse.urlunsplit(
            split._replace(netloc=f"{username}:***@{host_port}")
        )
    except ValueError:
        return "***"


def scrub_secrets(text: str, config: dict | None, environ: dict) -> str:
    """Replace any resolved proxy URL (which may embed credentials) and the
    Apify Proxy password itself inside free-form ``text`` -- e.g. an exception
    message from urllib, which can quote the proxy URL it failed against --
    with masked equivalents. ``mask_proxy_url`` alone only handles a string
    that IS a URL, not one buried mid-sentence."""
    for url in (config or {}).get("urls", []):
        text = text.replace(url, mask_proxy_url(url))
    password = environ.get("APIFY_PROXY_PASSWORD")
    if password:
        text = text.replace(password, "***")
    return text


def resolve_proxy_configuration(proxy_input: object, environ: dict) -> dict | None:
    """Resolve the platform proxy-editor object into a usable configuration,
    mirroring ``Actor.create_proxy_configuration(actor_proxy_input=...)``.

    Returns ``None`` for "no proxy" (absent input, or ``useApifyProxy`` falsy
    with no ``proxyUrls``), else a dict with:

    - ``kind`` -- ``"apify"`` or ``"custom"``,
    - ``urls`` -- the full, unmasked proxy URL list (a single URL for Apify
      Proxy; ``new_url`` below rotates over it),
    - ``username`` -- the Apify Proxy username (``None`` for custom).

    Raises :class:`ProxyConfigurationError` on anything the SDK would raise a
    ValueError for: a malformed ``proxyConfiguration`` shape, an invalid group
    name / country code / proxy URL, or Apify Proxy requested with no
    ``APIFY_PROXY_PASSWORD`` available.
    """
    if proxy_input is None:
        return None
    if not isinstance(proxy_input, dict):
        raise ProxyConfigurationError(
            f"Input field 'proxyConfiguration' must be an object, got {type(proxy_input).__name__}."
        )

    if proxy_input.get("useApifyProxy"):
        groups = proxy_input.get("apifyProxyGroups") or []
        if not isinstance(groups, list) or not all(
            isinstance(g, str) and APIFY_PROXY_VALUE_RE.fullmatch(g) for g in groups
        ):
            raise ProxyConfigurationError(
                f"Invalid 'apifyProxyGroups': {groups!r} (expected a list of proxy group names)."
            )
        country = proxy_input.get("apifyProxyCountry") or None
        if country is not None and not (
            isinstance(country, str) and COUNTRY_CODE_RE.fullmatch(country)
        ):
            raise ProxyConfigurationError(
                f"Invalid 'apifyProxyCountry': {country!r} (expected a two-letter ISO country code, e.g. 'US')."
            )
        password = environ.get("APIFY_PROXY_PASSWORD")
        if not password:
            # The SDK's own missing-password message, plus how to fix it here.
            raise ProxyConfigurationError(
                "Apify Proxy password must be provided using the APIFY_PROXY_PASSWORD "
                "environment variable. Start the runtime container with "
                "-e APIFY_PROXY_PASSWORD=<your password from https://console.apify.com/proxy> "
                "to make it inject one into every Actor run."
            )
        hostname = environ.get("APIFY_PROXY_HOSTNAME") or "proxy.apify.com"
        port = environ.get("APIFY_PROXY_PORT") or "8000"
        # The SDK's username scheme: comma-joined `groups-A+B` / `country-XX`
        # parts, `auto` when no option narrows the pool.
        parts = []
        if groups:
            parts.append("groups-" + "+".join(groups))
        if country:
            parts.append(f"country-{country}")
        username = ",".join(parts) if parts else "auto"
        return {
            "kind": "apify",
            "urls": [f"http://{username}:{password}@{hostname}:{port}"],
            "username": username,
        }

    proxy_urls = proxy_input.get("proxyUrls") or []
    if not isinstance(proxy_urls, list) or not all(isinstance(u, str) for u in proxy_urls):
        raise ProxyConfigurationError(
            f"Invalid 'proxyUrls': {mask_proxy_url(str(proxy_urls))!r} (expected a list of proxy URLs)."
        )
    for url in proxy_urls:
        split = urllib.parse.urlsplit(url)
        if split.scheme not in ("http", "https") or not split.hostname:
            raise ProxyConfigurationError(
                f"Invalid proxy URL in 'proxyUrls': {mask_proxy_url(url)!r} "
                "(expected http(s)://[user:pass@]host:port)."
            )
    if not proxy_urls:
        return None
    return {"kind": "custom", "urls": list(proxy_urls), "username": None}


def new_url(config: dict, state: dict) -> str:
    """The SDK's ``ProxyConfiguration.new_url()``: round-robin over the
    configured URLs (a single-URL Apify config just keeps returning it).
    ``state`` carries the rotation index between calls."""
    index = state.get("next", 0)
    state["next"] = (index + 1) % len(config["urls"])
    return config["urls"][index]


def http_get(url: str, proxy_url: str | None, timeout: float) -> tuple[int, bytes]:
    """GET ``url``, through ``proxy_url`` when given, with stdlib urllib.

    A separate function so tests monkeypatch it -- the rest of the Actor is
    then fully offline. urllib carries userinfo credentials from the proxy URL
    as Proxy-Authorization, for plain requests and CONNECT tunnels alike, so
    both http and https targets work through an authenticated proxy.
    """
    handlers = [urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url} if proxy_url else {})]
    opener = urllib.request.build_opener(*handlers)
    with opener.open(url, timeout=timeout) as response:
        return response.status, response.read()


def check_apify_proxy_access(config: dict, environ: dict, state: dict) -> dict:
    """The SDK's ``_check_access``: fetch ``{status_url}/?format=json``
    THROUGH the new proxy URL, up to ``ACCESS_CHECK_ATTEMPTS`` times.

    - No response at all (offline, firewalled): a warning only -- the SDK does
      not fail the run for an unreachable status page.
    - A response with ``connected: false`` (typically a wrong password): fails
      the run with the status page's own ``connectionError`` message.
    """
    status_url = (environ.get("APIFY_PROXY_STATUS_URL") or "http://proxy.apify.com").rstrip("/")
    check_url = f"{status_url}/?format=json"
    status = None
    for _ in range(ACCESS_CHECK_ATTEMPTS):
        try:
            _, body = http_get(check_url, new_url(config, state), ACCESS_CHECK_TIMEOUT_SECS)
            status = json.loads(body)
            break
        except Exception:  # noqa: BLE001 - retry, then degrade to a warning
            continue
    if status is None:
        note = f"Apify Proxy access check could not reach {check_url}; continuing without verification."
        print(f"WARNING: {note}", flush=True)
        return {"performed": True, "connected": None, "note": note}
    if not status.get("connected"):
        raise ProxyConfigurationError(
            f"Apify Proxy access check failed: {status.get('connectionError') or 'not connected'}"
        )
    return {"performed": True, "connected": True, "note": "ok"}


def masked_input_echo(actor_input: dict) -> dict:
    """The input echoed into OUTPUT, with any ``proxyConfiguration.proxyUrls``
    credentials masked -- the raw INPUT record already holds the original."""
    echo = dict(actor_input)
    proxy_input = echo.get("proxyConfiguration")
    if isinstance(proxy_input, dict) and isinstance(proxy_input.get("proxyUrls"), list):
        echo["proxyConfiguration"] = dict(
            proxy_input,
            proxyUrls=[mask_proxy_url(u) if isinstance(u, str) else u for u in proxy_input["proxyUrls"]],
        )
    return echo


def main() -> None:
    kv = default_dir("key_value_stores")
    input_path = kv / "INPUT.json"
    actor_input = json.loads(input_path.read_text()) if input_path.exists() else {}
    if not isinstance(actor_input, dict):
        actor_input = {}

    print("Proxy sample Actor started.", flush=True)
    try:
        config = resolve_proxy_configuration(actor_input.get("proxyConfiguration"), dict(os.environ))
        state: dict = {}

        access_check = None
        if config is None:
            print("No proxy configured: requests would be made directly.", flush=True)
        else:
            masked = [mask_proxy_url(u) for u in config["urls"]]
            print(f"Resolved {config['kind']} proxy configuration: {masked}", flush=True)
            if config["kind"] == "apify":
                access_check = check_apify_proxy_access(config, dict(os.environ), state)
                print(f"Apify Proxy access check: {access_check['note']}", flush=True)

        fetch = None
        target_url = actor_input.get("targetUrl")
        if isinstance(target_url, str) and target_url:
            proxy_url = new_url(config, state) if config else None
            via = mask_proxy_url(proxy_url) if proxy_url else None
            print(f"Fetching {target_url} via proxy: {via or 'none (direct)'}", flush=True)
            try:
                status_code, body = http_get(target_url, proxy_url, FETCH_TIMEOUT_SECS)
            except Exception as exc:  # noqa: BLE001 - fail the run with a masked, readable error
                raise ProxyConfigurationError(
                    f"Fetching {target_url!r} via proxy {via or 'none (direct)'} failed: "
                    f"{scrub_secrets(str(exc), config, dict(os.environ))}"
                ) from exc
            fetch = {
                "url": target_url,
                "viaProxy": via,
                "status": status_code,
                "bodyPreview": body[:FETCH_BODY_PREVIEW_BYTES].decode("utf-8", errors="replace"),
            }
            print(f"Fetched {target_url}: HTTP {status_code}", flush=True)
    except ProxyConfigurationError as exc:
        # One clear line, then a non-zero exit so the run reaches FAILED --
        # the same observable outcome the SDK's raised error produces on the
        # platform.
        print(f"ERROR: {exc}", flush=True)
        sys.exit(1)

    masked_urls = [mask_proxy_url(u) for u in config["urls"]] if config else []
    output = {
        "proxy": {
            "used": config["kind"] if config else "none",
            "proxyUrls": masked_urls,
            "username": config["username"] if config else None,
            "accessCheck": access_check,
        },
        # Which proxy env vars the runtime injected (values are connection
        # facts; the password itself is never echoed, only whether it was set).
        "apifyProxyEnv": {
            "hostname": os.environ.get("APIFY_PROXY_HOSTNAME"),
            "port": os.environ.get("APIFY_PROXY_PORT"),
            "statusUrl": os.environ.get("APIFY_PROXY_STATUS_URL"),
            "passwordSet": bool(os.environ.get("APIFY_PROXY_PASSWORD")),
        },
        "fetch": fetch,
        "receivedInput": masked_input_echo(actor_input),
        "status": "ok",
    }
    (kv / "OUTPUT.json").write_text(json.dumps(output))

    # Dataset: one item per resolved proxy URL (masked), in the SDK's
    # round-robin rotation order -- or a single explicit "no proxy" item, so
    # the dataset always shows what the run resolved.
    ds = default_dir("datasets")
    if config is None:
        (ds / "000000001.json").write_text(json.dumps({"proxyUrl": None, "kind": "none", "index": 1}))
    else:
        rotation: dict = {}
        for i in range(len(config["urls"])):
            (ds / f"{i + 1:09d}.json").write_text(
                json.dumps({
                    "proxyUrl": mask_proxy_url(new_url(config, rotation)),
                    "kind": config["kind"],
                    "index": i + 1,
                })
            )

    print("Proxy sample Actor finished.", flush=True)


if __name__ == "__main__":
    main()
