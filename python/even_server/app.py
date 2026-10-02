"""The HTTP surface (PROTOCOL.md section 6) as a FastAPI app.

Bodies and query strings are parsed by hand rather than by FastAPI models, so
that validation order and error shapes follow the protocol exactly: every error
is `{"error", "message"?, "index"?, "reason"?}`, never FastAPI's defaults.
"""

import math
import re
import secrets
import time
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import __version__, auth, b64, logs
from .config import Config
from .db import GroupFull, GroupState, OverBudget, Store
from .envelope import first_occurrences, parse_append_body
from .errors import JSON, ApiError, framework_error, invalid_request, rate_limited
from .limits import info_document
from .ratelimit import RateLimiter, SlidingWindow, client_address, ip_key

EPOCH_BYTES = 16
MAX_SEQ = 2**63 - 1  # SQLite INTEGER
_QUERY_INT = re.compile(r"-?[0-9]{1,4000}")


def new_epoch() -> str:
    return b64.encode(secrets.token_bytes(EPOCH_BYTES))


def create_app(config: Config, *, store: Store | None = None, limiter: RateLimiter | None = None) -> FastAPI:
    """Build the app. Creates the schema if needed and seeds the `limits` table
    from `config`; from then on every limit is read back from the table."""
    store = store or Store(config.db_path)
    store.init()
    store.seed_limits(config.limits)
    limiter = limiter or RateLimiter()

    app = FastAPI(
        title="Even sync server",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        redirect_slashes=False,
    )
    app.state.config = config
    app.state.store = store
    app.state.limiter = limiter
    app.add_middleware(EdgeMiddleware)
    app.add_exception_handler(ApiError, _api_error)
    app.add_exception_handler(StarletteHTTPException, _framework_error)
    app.add_exception_handler(RequestValidationError, _validation_error)

    def client_key(request: Request) -> str:
        peer = request.client.host if request.client else None
        return ip_key(client_address(peer, request.headers, config.trust_proxy_header))

    def enforce(key: str, *rules: tuple[SlidingWindow, int]) -> None:
        if wait := limiter.check(key, *rules):
            raise rate_limited(wait)

    async def prelude(request: Request) -> tuple[str, GroupState, str]:
        """design.md "Request handling": group id, token, rate limit, then
        blocklist. The thresholds live in the limits table, so the local
        database is read first; the order clients see is the Worker's."""
        group_id: str = request.path_params["groupId"]
        auth.check_group_id(group_id)
        auth.authenticate(group_id, request.headers.get("authorization"))
        state = await run_in_threadpool(store.group_state, group_id)
        key = client_key(request)
        enforce(key, (limiter.requests, state.limits.requests_per_minute))
        if state.blocked:
            raise ApiError(410, "group_blocked", "this group is blocked on this server")
        return group_id, state, key

    @app.get("/v1/info")
    async def info(request: Request) -> JSON:
        limits = await run_in_threadpool(store.limits)
        enforce(client_key(request), (limiter.requests, limits.requests_per_minute))
        return JSON(info_document(limits, operator=config.operator, terms=config.terms_url))

    @app.post("/v1/groups/{groupId}/events")
    async def append_events(request: Request) -> JSON:
        group_id, state, key = await prelude(request)
        limits = state.limits
        envelopes = parse_append_body(await _read_body(request, limits.max_body_bytes), limits)

        rules = [(limiter.writes, limits.writes_per_minute)]
        if not state.exists:
            rules.append((limiter.creates, limits.group_creates_per_minute))
        enforce(key, *rules)

        now_ms = time.time_ns() // 1_000_000
        now = datetime.fromtimestamp(now_ms / 1000, UTC)
        try:
            result = await run_in_threadpool(
                store.append,
                group_id,
                first_occurrences(envelopes),
                epoch=new_epoch(),
                now_ms=now_ms,
                day=now.date().isoformat(),
            )
        except GroupFull as full:
            limit = limits.max_group_bytes if full.reason == "bytes" else limits.max_group_events
            raise ApiError(413, "group_full", f"write would exceed max_group_{full.reason} ({limit})",
                           reason=full.reason) from None
        except OverBudget:
            raise ApiError(503, "over_budget", "the server's daily write budget is exhausted; reads still work",
                           headers={"Retry-After": str(_seconds_until_utc_midnight(now))}) from None
        return JSON({
            "accepted": result.accepted,
            "duplicates": len(envelopes) - result.accepted,
            "seq": result.seq,
            "epoch": result.epoch,
        })

    @app.get("/v1/groups/{groupId}/events")
    async def read_events(request: Request) -> JSON:
        group_id, state, _ = await prelude(request)
        max_page = state.limits.max_page
        since = _query_int(request, "since", 0)
        limit = _query_int(request, "limit", max_page)
        if not 0 <= since <= MAX_SEQ:
            raise invalid_request("since must be a non-negative integer")
        if limit < 1:
            raise invalid_request("limit must be at least 1")
        page = await run_in_threadpool(store.read, group_id, since, min(limit, max_page))
        return JSON({
            "events": page.events,
            "next": page.events[-1]["seq"] if page.events else since,
            "more": page.more,
            "epoch": page.epoch,
        })

    @app.delete("/v1/groups/{groupId}")
    async def delete_group(request: Request) -> Response:
        group_id, _, _ = await prelude(request)
        await run_in_threadpool(store.delete, group_id)
        return Response(status_code=204)

    @app.put("/v1/groups/{groupId}/subscriptions")
    async def subscriptions(request: Request) -> JSON:
        await prelude(request)
        raise ApiError(501, "not_implemented", "push subscriptions are not implemented by this server")

    return app


async def _read_body(request: Request, max_bytes: int) -> bytes:
    declared = request.headers.get("content-length", "")
    if declared.isascii() and declared.isdigit() and int(declared) > max_bytes:
        raise invalid_request("body is larger than any valid batch")
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > max_bytes:
            raise invalid_request("body is larger than any valid batch")
    return bytes(body)


def _query_int(request: Request, name: str, default: int) -> int:
    raw = request.query_params.get(name)
    if raw is None:
        return default
    if not _QUERY_INT.fullmatch(raw):
        raise invalid_request(f"{name} must be an integer")
    return int(raw)


def _seconds_until_utc_midnight(now: datetime) -> int:
    midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(1, math.ceil((midnight - now).total_seconds()))


# -- error mapping ------------------------------------------------------------

async def _api_error(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, ApiError)
    return exc.response()


async def _framework_error(request: Request, exc: Exception) -> Response:
    """Routing errors (404 unknown route, 405 wrong method) in protocol shape."""
    assert isinstance(exc, StarletteHTTPException)
    status, error = framework_error(exc.status_code)
    headers = {"Allow": ", ".join(_allowed_methods(request))} if status == 405 else None
    return ApiError(status, error, headers=headers).response()


async def _validation_error(request: Request, exc: Exception) -> Response:
    return invalid_request("request does not match the documented shape").response()


def _allowed_methods(request: Request) -> list[str]:
    """Every method any route accepts for this path (Starlette's own 405 names
    only the first partially matching route's methods)."""
    path = request.scope["path"]
    methods: set[str] = set()
    for route in request.app.router.routes:
        regex = getattr(route, "path_regex", None)
        if regex is not None and regex.match(path):
            methods |= getattr(route, "methods", None) or set()
    return sorted(methods)


# -- edge middleware ------------------------------------------------------------

def _route_pattern(scope: Scope) -> str | None:
    return getattr(scope.get("route"), "path", None)


class EdgeMiddleware:
    """Wraps every request: `Cache-Control: no-store` on every response, one JSON
    log line per request (route pattern, never the URL), and a protocol-shaped
    500 for anything unhandled, logged by type only. Swallowing the exception
    here keeps the server's own traceback (whose message could hold request
    data) out of the log."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = time.perf_counter()
        status: int | None = None

        async def send_no_store(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message.setdefault("headers", [])
                MutableHeaders(scope=message)["Cache-Control"] = "no-store"
            await send(message)

        try:
            await self.app(scope, receive, send_no_store)
        except Exception as exc:
            logs.log_exception(_route_pattern(scope), exc)
            if status is None:
                try:
                    await ApiError(500, "server_error").response()(scope, receive, send_no_store)
                except Exception:
                    pass  # the client is gone
        finally:
            logs.log_request(scope["method"], _route_pattern(scope), status, (time.perf_counter() - started) * 1000)
