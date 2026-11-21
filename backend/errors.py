"""Coded API errors: every new error body is {"detail": str, "code": str} (snake_case codes).

Plain fastapi.HTTPException responses keep FastAPI's default {"detail": ...} body, so the
existing detail texts (asserted by tests and shown by the UI) never change.
"""
from __future__ import annotations

from collections.abc import Mapping

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse


class ApiError(HTTPException):
    """HTTPException with a machine-readable code, e.g. ApiError(422, "Student name is required.",
    "invalid_student_name"). The UI maps codes to actions (errorCode() in lib/api.ts)."""

    def __init__(
        self,
        status_code: int,
        detail: str,
        code: str,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(status_code=status_code, detail=detail, headers=dict(headers) if headers else None)
        self.code = code


async def _api_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiError)
    return JSONResponse({"detail": exc.detail, "code": exc.code}, status_code=exc.status_code, headers=exc.headers)


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _api_error_handler)
