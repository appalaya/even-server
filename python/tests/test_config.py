import re
from pathlib import Path

import pytest

from even_server.config import LIMIT_VARIABLES, Config, ConfigError
from even_server.limits import Limits


def test_defaults_match_the_design_table():
    config = Config.from_env({})
    assert config.limits == Limits(
        max_event_bytes=8192, max_group_bytes=2097152, max_group_events=10000, max_batch=25, max_page=500,
        daily_write_budget=0, requests_per_minute=120, writes_per_minute=60, group_creates_per_minute=3,
        retention_days=365,
    )
    assert (config.db_path, config.host, config.port) == ("./even.db", "127.0.0.1", 8787)
    assert (config.trust_proxy_header, config.operator, config.terms_url) == (None, None, None)


def test_every_variable_is_read():
    config = Config.from_env({
        "EVEN_MAX_EVENT_BYTES": "4096", "EVEN_MAX_GROUP_BYTES": "65536", "EVEN_MAX_GROUP_EVENTS": "200",
        "EVEN_MAX_BATCH": "10", "EVEN_MAX_PAGE": "50", "EVEN_RETENTION_DAYS": "30",
        "EVEN_RATE_REQUESTS_PER_MINUTE": "1", "EVEN_RATE_WRITES_PER_MINUTE": "2",
        "EVEN_RATE_GROUP_CREATES_PER_MINUTE": "3", "EVEN_DAILY_WRITE_BUDGET": "5000",
        "EVEN_TRUST_PROXY_HEADER": "X-Forwarded-For", "EVEN_OPERATOR": "me", "EVEN_TERMS_URL": "https://t",
        "EVEN_DB_PATH": "/data/even.db", "EVEN_HOST": "0.0.0.0", "EVEN_PORT": "9000",
    })
    assert config.limits.rows() == [
        ("max_event_bytes", 4096), ("max_group_bytes", 65536), ("max_group_events", 200), ("max_batch", 10),
        ("max_page", 50), ("daily_write_budget", 5000), ("requests_per_minute", 1), ("writes_per_minute", 2),
        ("group_creates_per_minute", 3), ("retention_days", 30),
    ]
    assert config.trust_proxy_header == "x-forwarded-for"
    assert (config.operator, config.terms_url, config.db_path, config.host, config.port) == (
        "me", "https://t", "/data/even.db", "0.0.0.0", 9000)
    assert not config.listens_on_loopback


@pytest.mark.parametrize("env", [
    {"EVEN_MAX_BATCH": "ten"},
    {"EVEN_MAX_BATCH": "0"},
    {"EVEN_MAX_BATCH": "-1"},
    {"EVEN_MAX_EVENT_BYTES": "16"},
    {"EVEN_RETENTION_DAYS": "0"},
    {"EVEN_RATE_WRITES_PER_MINUTE": "0"},
    {"EVEN_PORT": "70000"},
    {"EVEN_TRUST_PROXY_HEADER": "X-Real-IP"},
])
def test_invalid_values_are_refused_at_start(env):
    with pytest.raises(ConfigError):
        Config.from_env(env)


def test_empty_values_mean_unset():
    assert Config.from_env({"EVEN_MAX_BATCH": "", "EVEN_TRUST_PROXY_HEADER": " "}) == Config.from_env({})


def test_limit_variables_match_the_worker_and_design_md():
    """Both references read the same EVEN_* names into the same table keys, with
    the same defaults and minimums, and design.md documents those defaults."""
    repo = Path(__file__).resolve().parents[2]
    vars_ts, wrangler, design = repo / "worker/src/vars.ts", repo / "worker/wrangler.jsonc", repo / "design.md"
    if not all(path.exists() for path in (vars_ts, wrangler, design)):
        pytest.skip("not running inside the full repository")
    ours = {name: (key, default, minimum) for name, key, default, minimum in LIMIT_VARIABLES}
    defaults = {name: default for name, (_, default, _) in ours.items()}

    worker = {name: (key, int(default.replace("_", "")), int(minimum)) for name, key, default, minimum in re.findall(
        r"variable: '(EVEN_\w+)',\s*key: '(\w+)',\s*fallback: ([\d_]+),\s*minimum: (\d+)", vars_ts.read_text())}
    assert worker == ours

    top_level = wrangler.read_text().split('"env":')[0]  # the production vars, not env.test
    assert {name: int(value) for name, value in re.findall(r'"(EVEN_\w+)": "(\d+)"', top_level)} == defaults

    documented = re.findall(r"^\| `(EVEN_\w+)` \| `(\d+)`", design.read_text(), re.MULTILINE)
    assert {name: int(value) for name, value in documented} == defaults
