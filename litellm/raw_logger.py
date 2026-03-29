"""
LiteLLM Custom Callback – 原始 Input / Output 日志
将请求体和响应体以 raw JSON 形式输出到容器 stdout，
并保存为 jsonl 格式。
"""

import json
import os
from datetime import datetime, timezone

import litellm
from litellm.integrations.custom_logger import CustomLogger


class RawLogger(CustomLogger):
    """Log raw request/response payloads to jsonl."""

    _LOG_FILE = "/app/litellm.jsonl"

    def __init__(self):
        super().__init__()

    # ── File logging helper ──────────────────────────────────────────────

    def _write_jsonl(self, record: dict):
        try:
            line = json.dumps(record, ensure_ascii=False, default=str)
            with open(self._LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
            print(line, flush=True)
        except Exception as e:
            print("[raw_logger] Error writing jsonl: " + str(e), flush=True)

    # ── Sync hooks (fallback) ───────────────────────────────────────────
    def log_pre_api_call(self, model, messages, kwargs):
        call_id = kwargs.get("litellm_call_id", "unknown")
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": "pre_api_call",
            "call_id": call_id,
            "model": str(model),
            "request": {
                "messages": messages,
                "optional_params": kwargs.get("optional_params", {})
            }
        }
        self._write_jsonl(record)

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._print_response(kwargs, response_obj, start_time, end_time)

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._print_failure(kwargs, response_obj, start_time, end_time)

    # ── Async hooks (preferred by LiteLLM proxy) ────────────────────────
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._print_response(kwargs, response_obj, start_time, end_time)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._print_failure(kwargs, response_obj, start_time, end_time)

    # ── Printers ────────────────────────────────────────────────────────
    def _print_response(self, kwargs: dict, response_obj, start_time, end_time):
        duration = (end_time - start_time).total_seconds() if start_time and end_time else 0
        resp = response_obj.model_dump() if hasattr(response_obj, "model_dump") else response_obj
        call_id = kwargs.get("litellm_call_id", "unknown")
        
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": "success",
            "call_id": call_id,
            "model": kwargs.get("model", "?"),
            "duration_s": round(duration, 3),
            "request": {
                "messages": kwargs.get("messages", None),
                "optional_params": kwargs.get("optional_params", {})
            },
            "response": resp
        }
        self._write_jsonl(record)

    def _print_failure(self, kwargs: dict, response_obj, start_time, end_time):
        duration = (end_time - start_time).total_seconds() if start_time and end_time else 0
        call_id = kwargs.get("litellm_call_id", "unknown")
        
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": "failure",
            "call_id": call_id,
            "model": kwargs.get("model", "?"),
            "duration_s": round(duration, 3),
            "request": {
                "messages": kwargs.get("messages", None),
                "optional_params": kwargs.get("optional_params", {})
            },
            "error": str(response_obj),
            "exception": str(kwargs.get("exception", ""))
        }
        self._write_jsonl(record)


# Instantiate — referenced in litellm_config.yaml as raw_logger.raw_logger
raw_logger = RawLogger()
