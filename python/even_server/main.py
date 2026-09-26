"""Command line: `even-server` (serve), `block`, `unblock`, `expire-now`.

Configuration comes from `EVEN_*` environment variables (see README.md); the
flags below override the few that are handy on a command line.
"""

import argparse
import dataclasses
import logging
import os
import sys
import time

from . import __version__, auth, logs
from .config import Config, ConfigError
from .db import Store
from .expiry import ExpiryThread, expire_once
from .limits import LimitsMissing

log = logging.getLogger("even.main")

# The uvicorn settings the logging invariant depends on (THREAT-MODEL.md, "What
# we log"). The tests start their live server with these too.
UVICORN_OPTIONS: dict[str, object] = {
    "access_log": False,     # uvicorn's access log records the URL, which contains the group id
    "ws": "none",            # no WebSockets: uvicorn logs every handshake with the client address and URL
    "proxy_headers": False,  # client addresses come only from EVEN_TRUST_PROXY_HEADER
    "server_header": False,
    "log_config": None,      # keep the JSON logging configured by logs.configure()
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="even-server",
        description="Even sync server (Python reference). Stores client-encrypted envelopes it cannot read.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument("--db", metavar="PATH", help="SQLite database path (default: $EVEN_DB_PATH or ./even.db)")
    parser.add_argument("--host", help="listen address (default: $EVEN_HOST or 127.0.0.1)")
    parser.add_argument("--port", type=int, help="listen port (default: $EVEN_PORT or 8787)")
    parser.add_argument("--expire-now", action="store_true", help="same as the expire-now command")
    commands = parser.add_subparsers(dest="command", metavar="COMMAND")
    commands.add_parser("serve", help="run the HTTP server (the default)")
    block = commands.add_parser("block", help="block a group id: every request for it answers 410 group_blocked")
    block.add_argument("group_id", metavar="GROUP_ID")
    block.add_argument("--purge", action="store_true", help="also delete the group's stored events now")
    unblock = commands.add_parser("unblock", help="remove a group id from the blocklist")
    unblock.add_argument("group_id", metavar="GROUP_ID")
    commands.add_parser("expire-now", help="delete groups idle for longer than EVEN_RETENTION_DAYS, then exit")
    return parser


def _protect_group_ids(argv: list[str]) -> list[str]:
    """A base64url group id may begin with '-', which argparse would take for an
    option. No option is 43 characters of the id alphabet, so such tokens are
    moved behind '--', where argparse reads them as positionals."""
    if "--" in argv:
        return argv
    ids = [arg for arg in argv if arg.startswith("-") and auth.is_group_id(arg)]
    if not ids:
        return argv
    return [arg for arg in argv if arg not in ids] + ["--", *ids]


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(_protect_group_ids(sys.argv[1:] if argv is None else argv))
    try:
        config = Config.from_env(os.environ)
    except ConfigError as exc:
        print(f"even-server: {exc}", file=sys.stderr)
        return 2
    overrides = {name: value for name, value in (("db_path", args.db), ("host", args.host), ("port", args.port))
                 if value is not None}
    config = dataclasses.replace(config, **overrides)

    command = "expire-now" if args.expire_now else (args.command or "serve")
    match command:
        case "serve":
            return serve(config)
        case "block" | "unblock":
            return edit_blocklist(config, command, args.group_id, purge=getattr(args, "purge", False))
        case "expire-now":
            store = _store(config)
            try:
                store.limits()
            except LimitsMissing:  # never served yet: fall back to the environment's retention
                store.seed_limits(config.limits)
            print(f"expired {expire_once(store)} idle group(s)")
            return 0
        case _:
            parser.error(f"unknown command {command}")


def _store(config: Config) -> Store:
    """The database for an operator command. Deliberately does NOT re-seed the
    limits table: the running server reads its limits from that table, and a
    shell without the server's environment would silently change them."""
    store = Store(config.db_path)
    store.init()
    return store


def edit_blocklist(config: Config, command: str, group_id: str, *, purge: bool) -> int:
    if not auth.is_group_id(group_id):
        print("even-server: GROUP_ID must be 43 base64url characters", file=sys.stderr)
        return 2
    store = _store(config)
    if command == "block":
        added = store.block(group_id, time.time_ns() // 1_000_000, purge=purge)
        print("blocked" if added else "already blocked", end="")
        print("; stored events deleted" if purge else "; stored events kept until expiry (use --purge to delete)")
    else:
        print("unblocked" if store.unblock(group_id) else "was not blocked")
    return 0


def serve(config: Config) -> int:
    import uvicorn

    from .app import create_app

    logs.configure()
    if config.trust_proxy_header and not config.listens_on_loopback:
        log.warning(
            "trusting a proxy header while listening on a non-loopback address; "
            "clients that can reach this port directly can forge it to dodge rate limits"
        )
    app = create_app(config)
    expiry = ExpiryThread(app.state.store)
    expiry.start()
    # uvicorn's own "running on" line loses its arguments in our log (see logs.JsonFormatter).
    log.info("serve", extra={"fields": {"event": "serve", "host": config.host, "port": config.port}})
    try:
        uvicorn.run(app, host=config.host, port=config.port, **UVICORN_OPTIONS)  # type: ignore[arg-type]
    finally:
        expiry.stop()
    return 0
