"""Protocol errors (PROTOCOL.md section 7). Every error body is
`{"error", "message"?, "index"?, "reason"?}`."""

from collections.abc import Mapping
from typing import Any

from starlette.responses import JSONResponse


class JSON(JSONResponse):
    media_type = "application/json; charset=utf-8"


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        error: str,
        message: str | None = None,
        *,
        index: int | None = None,
        reason: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(error)
        self.status = status
        self.error = error
        self.message = message
        self.index = index
        self.reason = reason
        self.headers = dict(headers or {})

    def response(self) -> JSON:
        body: dict[str, Any] = {"error": self.error}
        if self.message is not None:
            body["message"] = self.message
        if self.index is not None:
            body["index"] = self.index
        if self.reason is not None:
            body["reason"] = self.reason
        return JSON(body, status_code=self.status, headers=self.headers)


def invalid_request(message: str) -> ApiError:
    return ApiError(400, "invalid_request", message)


def unauthorized(message: str) -> ApiError:
    return ApiError(401, "unauthorized", message)


def rate_limited(retry_after: int) -> ApiError:
    return ApiError(429, "rate_limited", "per-IP rate limit exceeded",
                    headers={"Retry-After": str(retry_after)})


# Status codes produced by the framework itself (routing, validation).
FRAMEWORK_ERRORS = {
    400: "invalid_request",
    401: "unauthorized",
    404: "not_found",
    405: "method_not_allowed",
}


def framework_error(status: int) -> tuple[int, str]:
    """(status, error) for a framework-raised HTTP error. 422 (FastAPI's
    validation status) is never sent: body-shape failures are 400."""
    if status == 422:
        return 400, "invalid_request"
    if status in FRAMEWORK_ERRORS:
        return status, FRAMEWORK_ERRORS[status]
    return (status, "server_error") if status >= 500 else (400, "invalid_request")
