"""Fixture Actor proving the real apify-client/SDK path end to end (success
criterion 20): a real client library instantiated *inside* a real actor
container reports ``is_at_home`` the way the client itself computes it, calls
back into the runtime's own API using its injected ``APIFY_TOKEN``, and
writes its result into its own default dataset THROUGH THE CLIENT (an
API-based storage write against the run's real dataset id) -- not by touching
local disk, unlike ``sample_actor``'s deliberately stdlib-only INPUT/OUTPUT
convention.

This is the one fixture exempt from the "stdlib-only" rule the other
``sample_actor*`` Actors follow (see ``.actor/Dockerfile``): it pip-installs
two real, published Apify packages at image BUILD time, when the Docker
host/CI running the e2e suite has normal internet egress. At RUN time its
only network use is calling the runtime's own API.

Two packages, two different jobs -- both verified against the real GitHub
sources rather than guessed:

- ``apify-client`` (repo ``apify/apify-client-python``) for the actual API
  calls. Verified from ``src/apify_client/_apify_client.py``:
  ``ApifyClient.__init__(self, token=None, *, api_url=DEFAULT_API_URL, ...)``,
  ``ApifyClient.user(user_id=None)`` -> ``UserClient`` (defaults to ``'me'``),
  ``UserClient.get()`` -> ``UserPublicInfo | UserPrivateInfo | None`` (per
  ``tests/integration/test_user.py`` in that repo: ``user.username`` is always
  present), ``ApifyClient.dataset(dataset_id)`` -> ``DatasetClient``, and
  ``DatasetClient.push_items(items: JsonSerializable)`` -> POSTs to that
  dataset's items endpoint (matching this runtime's own
  ``POST /v2/datasets/{id}/items`` in ``app/routers/storages.py``).
- ``apify`` (the Actor SDK, repo ``apify/apify-sdk-python``) for
  ``is_at_home`` -- ``apify-client`` itself has NO such helper: its
  ``_consts.py``, ``__init__.py`` and ``_apify_client.py`` were checked and
  none reference ``APIFY_IS_AT_HOME``. ``apify-shared-python`` only defines
  the ENV VAR NAME as a constant (``ApifyEnvVars.IS_AT_HOME ==
  "APIFY_IS_AT_HOME"``, in ``src/apify_shared/consts.py``), not a function
  that reads it. The actual boolean-computing helper lives in the Actor SDK:
  ``apify/_configuration.py`` defines
  ``Configuration.is_at_home: bool`` with
  ``Field(validation_alias='apify_is_at_home')`` (i.e. sourced from the
  ``APIFY_IS_AT_HOME`` env var this runtime sets to ``"1"`` for every run),
  and ``apify/_actor.py``'s ``Actor.is_at_home()`` is defined as exactly
  ``return self.configuration.is_at_home``. This fixture reads that same
  field via ``Configuration.get_global_configuration()`` -- the SDK's
  documented way to obtain the configuration without running the full
  ``Actor.init()``/``Actor.exit()`` lifecycle -- rather than re-implementing
  an ``os.environ`` check by hand.
"""
from __future__ import annotations

import os

from apify import Configuration
from apify_client import ApifyClient


def _resolve_username(me: object) -> str | None:
    """Best-effort read of the acting user's identity from whatever shape
    ``UserClient.get()`` returns: a ``UserPublicInfo``/``UserPrivateInfo``
    pydantic model per apify-client-python's current source (handled via
    ``getattr`` here), with a plain-dict fallback in case a different client
    version ever returns one.
    """
    if isinstance(me, dict):
        return me.get("username") or me.get("id")
    return getattr(me, "username", None) or getattr(me, "id", None)


def main() -> None:
    # (a) is_at_home, computed the way the real Actor SDK computes it.
    is_at_home = Configuration.get_global_configuration().is_at_home

    token = os.environ["APIFY_TOKEN"]
    api_url = os.environ["APIFY_API_BASE_URL"]
    dataset_id = os.environ["APIFY_DEFAULT_DATASET_ID"]

    client = ApifyClient(token=token, api_url=api_url)

    # (b) call back into the runtime's own API using the injected token.
    me = client.user("me").get()
    username = _resolve_username(me)

    result = {
        "is_at_home": bool(is_at_home),
        "user": username,
        "dataset_id": dataset_id,
    }
    print(f"isathome Actor resolved: {result}", flush=True)

    # (c) write the result into the run's real default dataset THROUGH THE
    # CLIENT -- an API-based storage write, not a local-disk write.
    client.dataset(dataset_id).push_items(result)

    print("isathome Actor finished: pushed result via apify-client.", flush=True)


if __name__ == "__main__":
    main()
