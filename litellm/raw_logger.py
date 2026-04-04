"""
LiteLLM Custom Callback – 原始 Input / Output 日志
将请求体和响应体以 raw JSON 形式输出到容器 stdout，
并保存为 jsonl 格式。
"""

import json
import os
import threading
from datetime import datetime, timezone

import litellm
from litellm.integrations.custom_logger import CustomLogger

class RawLogger(CustomLogger):
    """Log raw request/response payloads to jsonl."""

    _LOG_FILE = "/app/litellm.jsonl"
    _ERROR_LOG = "/app/raw_logger_error.log"
    _MAX_LINES = 50
    _lock = threading.Lock()

    def __init__(self):
        super().__init__()

    # ── File logging helper ──────────────────────────────────────────────

    def _write_jsonl(self, record: dict):
        try:
            try:
                line = json.dumps(record, ensure_ascii=False, default=str)
            except ValueError as ve:
                if "Circular" in str(ve) or "circular" in str(ve):
                    safe_record = {k: (str(v) if k in ["request", "response"] else v) for k, v in record.items()}
                    line = json.dumps(safe_record, ensure_ascii=False, default=str)
                else:
                    raise ve
            
            # 加锁保证 read-append-truncate-write 原子性，防止并发超限
            with self._lock:
                lines = []
                if os.path.exists(self._LOG_FILE):
                    with open(self._LOG_FILE, "r", encoding="utf-8") as f:
                        lines = f.readlines()
                
                lines.append(line + "\n")
                lines = lines[-self._MAX_LINES:]
                
                with open(self._LOG_FILE, "w", encoding="utf-8") as f:
                    f.writelines(lines)
            
            print(line, flush=True)
        except Exception as e:
            with open(self._ERROR_LOG, "a", encoding="utf-8") as ef:
                ef.write(f"{datetime.now(timezone.utc).isoformat()} [raw_logger] Error: {str(e)}\n")
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
        
        # Check if there is a complete assembled stream response
        final_obj = kwargs.get("complete_streaming_response")
        if final_obj is None:
            final_obj = response_obj
            
        try:
            if hasattr(final_obj, "model_dump"):
                resp = final_obj.model_dump()
            elif hasattr(final_obj, "dict"):
                resp = final_obj.dict()
            elif hasattr(final_obj, "json"):
                import json as _json
                try:
                    resp = _json.loads(final_obj.json())
                except:
                    resp = final_obj.json()
            elif isinstance(final_obj, dict):
                resp = final_obj
            else:
                try:
                    # Some litellm objects can be parsed using dump_obj
                    resp = getattr(final_obj, "__dict__", str(final_obj))
                except:
                    resp = str(final_obj)
        except:
            resp = str(final_obj)

        call_id = kwargs.get("litellm_call_id", "unknown")
        
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": "success",
            "call_id": call_id,
            "model": str(kwargs.get("model", "?")),
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
            "model": str(kwargs.get("model", "?")),
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
