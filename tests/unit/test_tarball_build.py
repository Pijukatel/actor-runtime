"""Tests for the TARBALL source-upload build path and no-stale-source guarantee.

All run Docker-free through the ``wired`` fixture (in-process app + StubDriver).
The StubDriver captures the materialized build directory before the service
rmtree's it, so tests can assert exactly which source was unzipped/written.
"""
from __future__ import annotations

import base64
import io
import stat
import zipfile

import pytest

from app.driver import SourceFileNameError, extract_zip


def _make_zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


def _make_zip_with_symlink(legit_name: str, legit_content: str, link_name: str, link_target: str) -> bytes:
    """A zip with one legitimate file plus one entry marked as a symlink via
    ``external_attr`` (the Unix mode bits ``S_IFLNK`` packed into the high 16
    bits, as real zip tools do for symlink entries)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(legit_name, legit_content)
        info = zipfile.ZipInfo(link_name)
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        zf.writestr(info, link_target)
    return buf.getvalue()


def _tarball_url(store_id: str, key: str) -> str:
    return f"http://test/key-value-stores/{store_id}/records/{key}?disableRedirect=true"


async def _put_record(client, store_name: str, key: str, body: bytes) -> str:
    """Create the KV store the way a real push does, then PUT bytes; return its id."""
    created = await client.post("/v2/key-value-stores", json={"name": store_name})
    store_id = created.json()["data"]["id"]
    put = await client.put(
        f"/v2/key-value-stores/{store_id}/records/{key}",
        content=body,
        headers={"content-type": "application/zip"},
    )
    assert put.status_code == 200
    return store_id


async def _create_actor(client, name: str) -> str:
    await client.post("/v2/acts", json={"name": name, "versions": [{"versionNumber": "0.0"}]})
    return f"local-user~{name}"


async def _build(client, service, actor_id: str) -> dict:
    build = (await client.post(f"/v2/acts/{actor_id}/builds?version=0.0")).json()["data"]
    await service.wait_idle()
    return (await client.get(f"/v2/actor-builds/{build['id']}")).json()["data"]


# -- Criterion 1: inline push still builds the pushed files (TEXT + BASE64) ----
async def test_inline_build_materializes_pushed_files(wired):
    client, service = wired
    actor_id = await _create_actor(client, "inline")
    blob = b"binary\x00\xff data"
    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [
                {"name": "main.py", "format": "TEXT", "content": "print('hi')\n"},
                {"name": ".actor/Dockerfile", "format": "TEXT", "content": "FROM scratch\n"},
                {"name": "blob.bin", "format": "BASE64", "content": base64.b64encode(blob).decode()},
            ],
        },
    )
    final = await _build(client, service, actor_id)
    assert final["status"] == "SUCCEEDED"
    captured = service.driver.captured_build_dir_contents
    assert captured["main.py"] == b"print('hi')\n"
    assert captured[".actor/Dockerfile"] == b"FROM scratch\n"
    assert captured["blob.bin"] == blob


# -- Criterion 2 + 7: a TARBALL build unzips the pushed zip's real contents ----
async def test_tarball_build_materializes_unzipped_source(wired):
    client, service = wired
    actor_id = await _create_actor(client, "tb")
    zip_bytes = _make_zip(
        {
            "main.py": "print('from tarball')\n",
            "src/util.py": "VALUE = 42\n",
            ".actor/Dockerfile": "FROM scratch\n",
        }
    )
    # Use whatever id the store-creation step returns, verbatim, in the URL.
    store_id = await _put_record(client, "tb-source", "version-0.0.zip", zip_bytes)
    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={"sourceType": "TARBALL", "tarballUrl": _tarball_url(store_id, "version-0.0.zip")},
    )
    final = await _build(client, service, actor_id)
    assert final["status"] == "SUCCEEDED"
    captured = service.driver.captured_build_dir_contents
    assert captured["main.py"] == b"print('from tarball')\n"
    assert captured["src/util.py"] == b"VALUE = 42\n"
    assert captured[".actor/Dockerfile"] == b"FROM scratch\n"


# -- Criterion 3a: tarball push after inline push builds only the tarball ------
async def test_no_stale_source_tarball_after_inline(wired):
    client, service = wired
    actor_id = await _create_actor(client, "sw1")
    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [
                {"name": "inline_marker.txt", "format": "TEXT", "content": "inline\n"},
                {"name": ".actor/Dockerfile", "format": "TEXT", "content": "FROM scratch\n"},
            ],
        },
    )
    first = await _build(client, service, actor_id)
    assert first["status"] == "SUCCEEDED"
    assert "inline_marker.txt" in service.driver.captured_build_files

    zip_bytes = _make_zip(
        {"tarball_marker.txt": "tarball\n", ".actor/Dockerfile": "FROM scratch\n"}
    )
    store_id = await _put_record(client, "sw1-source", "version-0.0.zip", zip_bytes)
    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={"sourceType": "TARBALL", "tarballUrl": _tarball_url(store_id, "version-0.0.zip")},
    )
    second = await _build(client, service, actor_id)
    assert second["status"] == "SUCCEEDED"
    files = service.driver.captured_build_files
    assert "tarball_marker.txt" in files
    assert "inline_marker.txt" not in files


# -- Criterion 3b: inline push after tarball push builds only the inline files -
async def test_no_stale_source_inline_after_tarball(wired):
    client, service = wired
    actor_id = await _create_actor(client, "sw2")
    zip_bytes = _make_zip(
        {"tarball_marker.txt": "tarball\n", ".actor/Dockerfile": "FROM scratch\n"}
    )
    store_id = await _put_record(client, "sw2-source", "version-0.0.zip", zip_bytes)
    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={"sourceType": "TARBALL", "tarballUrl": _tarball_url(store_id, "version-0.0.zip")},
    )
    first = await _build(client, service, actor_id)
    assert first["status"] == "SUCCEEDED"
    assert "tarball_marker.txt" in service.driver.captured_build_files

    # Delete the tarball record: a stale/superseded record must not resurrect it.
    await client.delete(f"/v2/key-value-stores/{store_id}")
    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [
                {"name": "inline_marker.txt", "format": "TEXT", "content": "inline\n"},
                {"name": ".actor/Dockerfile", "format": "TEXT", "content": "FROM scratch\n"},
            ],
        },
    )
    second = await _build(client, service, actor_id)
    assert second["status"] == "SUCCEEDED"
    files = service.driver.captured_build_files
    assert "inline_marker.txt" in files
    assert "tarball_marker.txt" not in files


# -- Criterion 4: serialized version reflects the pushed shape, clears other ---
async def test_version_dict_reflects_pushed_shape(wired):
    client, _ = wired
    actor_id = await _create_actor(client, "vd")

    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [{"name": "a.py", "format": "TEXT", "content": "x\n"}],
        },
    )
    v = (await client.get(f"/v2/actors/{actor_id}/versions/0.0")).json()["data"]
    assert v["sourceType"] == "SOURCE_FILES"
    assert v["sourceFiles"] == [{"name": "a.py", "format": "TEXT", "content": "x\n"}]
    assert "tarballUrl" not in v

    url = _tarball_url("local-user~vd-source", "version-0.0.zip")
    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={"sourceType": "TARBALL", "tarballUrl": url},
    )
    v = (await client.get(f"/v2/actors/{actor_id}/versions/0.0")).json()["data"]
    assert v["sourceType"] == "TARBALL"
    assert v["tarballUrl"] == url
    assert v["sourceFiles"] == []

    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [{"name": "b.py", "format": "TEXT", "content": "y\n"}],
        },
    )
    v = (await client.get(f"/v2/actors/{actor_id}/versions/0.0")).json()["data"]
    assert v["sourceType"] == "SOURCE_FILES"
    assert "tarballUrl" not in v
    assert v["sourceFiles"] == [{"name": "b.py", "format": "TEXT", "content": "y\n"}]


# -- Criterion 5: zip traversal safety (escaping entries fail the build) -------
async def test_tarball_traversal_entries_fail_build(wired, tmp_path):
    client, service = wired
    actor_id = await _create_actor(client, "tv")
    zip_bytes = _make_zip(
        {
            ".actor/Dockerfile": "FROM scratch\n",
            "../../evil.txt": "pwned\n",
            "/etc/evil.txt": "pwned\n",
        }
    )
    store_id = await _put_record(client, "tv-source", "version-0.0.zip", zip_bytes)
    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={"sourceType": "TARBALL", "tarballUrl": _tarball_url(store_id, "version-0.0.zip")},
    )
    final = await _build(client, service, actor_id)
    assert final["status"] == "FAILED"
    assert final["finishedAt"] is not None
    # Nothing escaped: no evil.txt landed anywhere in the surrounding tmp tree.
    # (The absolute-path entry's own coverage lives in
    # test_extract_zip_rejects_absolute_path below, which controls `dest`
    # directly instead of relying on a filesystem check that can never observe
    # where an unguarded absolute write would actually land.)
    assert not list(tmp_path.rglob("evil.txt"))


# -- extract_zip unit coverage: absolute entry names are rejected, nothing written
def test_extract_zip_rejects_absolute_path(tmp_path):
    dest = tmp_path / "build"
    outside_target = tmp_path / "evil.txt"
    zip_bytes = _make_zip({str(outside_target): "pwned\n"})
    with pytest.raises(SourceFileNameError):
        extract_zip(zip_bytes, dest)
    assert not outside_target.exists()
    assert not list(dest.rglob("*"))  # nothing written into dest either


# -- Regression: symlink zip entries are never materialized as links -----------
def test_extract_zip_skips_symlink_entries(tmp_path):
    dest = tmp_path / "build"
    zip_bytes = _make_zip_with_symlink(
        legit_name="main.py",
        legit_content="print('ok')\n",
        link_name="evil_link",
        link_target="../../etc/passwd",
    )
    extract_zip(zip_bytes, dest)
    # The legitimate file alongside the symlink entry still gets extracted.
    assert (dest / "main.py").read_text() == "print('ok')\n"
    # The symlink entry is never materialized as a file or a link, in dest...
    assert not (dest / "evil_link").exists()
    assert not (dest / "evil_link").is_symlink()
    # ...nor anywhere else in the surrounding tmp tree.
    assert not list(tmp_path.rglob("evil_link"))


# -- Criterion 6a: missing tarball record fails cleanly (not empty/SUCCEEDED) --
async def test_tarball_missing_record_fails_cleanly(wired):
    client, service = wired
    actor_id = await _create_actor(client, "mr")
    url = _tarball_url("local-user~mr-source", "version-0.0.zip")  # never PUT
    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={"sourceType": "TARBALL", "tarballUrl": url},
    )
    final = await _build(client, service, actor_id)
    assert final["status"] == "FAILED"
    assert final["finishedAt"] is not None
    log = (await service.get_build(final["id"])).log.lower()
    assert "not found" in log or "record" in log


# -- Criterion 6b: corrupt (non-zip) bytes fail cleanly -----------------------
async def test_tarball_corrupt_bytes_fail_cleanly(wired):
    client, service = wired
    actor_id = await _create_actor(client, "cb")
    store_id = await _put_record(client, "cb-source", "version-0.0.zip", b"this is not a zip file")
    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={"sourceType": "TARBALL", "tarballUrl": _tarball_url(store_id, "version-0.0.zip")},
    )
    final = await _build(client, service, actor_id)
    assert final["status"] == "FAILED"
    assert final["finishedAt"] is not None
    log = (await service.get_build(final["id"])).log.lower()
    assert "zip" in log or "archive" in log


# -- Criterion 7 (negative): lookup keys off the URL's store id, not a guess ---
async def test_tarball_reads_store_id_from_url_not_reconstructed(wired):
    client, service = wired
    actor_id = await _create_actor(client, "prov")
    zip_bytes = _make_zip({".actor/Dockerfile": "FROM scratch\n", "main.py": "x\n"})
    # Store the zip under one id, but point the URL at a DIFFERENT id.
    await _put_record(client, "prov-real-source", "version-0.0.zip", zip_bytes)
    wrong_url = _tarball_url("local-user~prov-wrong-source", "version-0.0.zip")
    await client.put(
        f"/v2/actors/{actor_id}/versions/0.0",
        json={"sourceType": "TARBALL", "tarballUrl": wrong_url},
    )
    final = await _build(client, service, actor_id)
    # A reconstructed/guessed id would have found the zip; keying off the URL's
    # (wrong) id must miss the record and fail per criterion 6a.
    assert final["status"] == "FAILED"
    assert final["finishedAt"] is not None
