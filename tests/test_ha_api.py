"""Reload holds the project lock until HA finishes reading its configuration."""
import asyncio
from types import SimpleNamespace

import pytest
from homeassistant.exceptions import Unauthorized

from custom_components.flode.const import DOMAIN
from custom_components.flode.file_source import CONF_DIRECTORY
from custom_components.flode.ha_api import _reload_project, reload_project
from custom_components.flode.project_lock import project_lock


def fake_hass(root, service):
    async def executor(function, *args):
        return await asyncio.to_thread(function, *args)

    return SimpleNamespace(
        data={DOMAIN: SimpleNamespace(options={}, data={CONF_DIRECTORY: str(root)})},
        async_add_executor_job=executor,
        async_create_task=asyncio.create_task,
        services=SimpleNamespace(async_call=service),
    )


def test_reload_holds_lock_until_service_finishes_even_when_client_cancels(tmp_path):
    (tmp_path / "automations").mkdir()
    root = tmp_path.resolve()
    lock = project_lock(str(root))

    async def scenario():
        started = asyncio.Event()
        finish = asyncio.Event()
        completed = asyncio.Event()

        async def service(domain, name, data, *, blocking):
            assert (domain, name, data, blocking) == ("homeassistant", "reload_all", {}, True)
            assert lock.locked()
            started.set()
            await finish.wait()
            assert lock.locked()
            completed.set()

        client = asyncio.create_task(_reload_project(fake_hass(root, service), str(root)))
        await asyncio.wait_for(started.wait(), 2)
        client.cancel()
        with pytest.raises(asyncio.CancelledError):
            await client
        assert lock.locked()
        finish.set()
        await asyncio.wait_for(completed.wait(), 2)
        await asyncio.sleep(0)
        assert not lock.locked()

    asyncio.run(scenario())


def test_reload_refuses_a_busy_project_and_a_stale_directory(tmp_path):
    (tmp_path / "automations").mkdir()
    root = tmp_path.resolve()

    async def service(*args, **kwargs):
        pytest.fail("HA must not reload")

    async def scenario():
        hass = fake_hass(root, service)
        with project_lock(str(root)), pytest.raises(ValueError, match="Another project"):
            await _reload_project(hass, str(root))
        with pytest.raises(ValueError, match="project changed"):
            await _reload_project(hass, str(root / "other"))

    asyncio.run(scenario())


def test_reload_releases_lock_after_service_failure(tmp_path):
    (tmp_path / "automations").mkdir()
    root = tmp_path.resolve()

    async def service(*args, **kwargs):
        raise ValueError("Invalid configuration")

    with pytest.raises(ValueError, match="Invalid configuration"):
        asyncio.run(_reload_project(fake_hass(root, service), str(root)))
    assert not project_lock(str(root)).locked()


def test_reload_refuses_non_prod_checkout(tmp_path, monkeypatch):
    (tmp_path / "automations").mkdir()
    root = tmp_path.resolve()

    def refuse(directory):
        assert directory == root
        raise ValueError("Return to prod")

    async def service(*args, **kwargs):
        pytest.fail("HA must not reload")

    monkeypatch.setattr("custom_components.flode.ha_api.require_prod_for_writes", refuse)
    with pytest.raises(ValueError, match="Return to prod"):
        asyncio.run(_reload_project(fake_hass(root, service), str(root)))
    assert not project_lock(str(root)).locked()


def test_reload_requires_admin():
    with pytest.raises(Unauthorized):
        reload_project(None, SimpleNamespace(user=SimpleNamespace(is_admin=False)), {"id": 1})
