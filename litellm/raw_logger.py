"""
LiteLLM Custom Callback – 原始 Input / Output 日志
将请求体和响应体保存到 SQLite3 数据库，自动维护记录上限。
"""

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone

import litellm
from litellm.integrations.custom_logger import CustomLogger


class RawLogger(CustomLogger):
    """Log raw request/response payloads to SQLite3."""

    _DB_PATH = "/app/logs/litellm_logs.db"
    _ERROR_LOG = "/app/logs/raw_logger_error.log"
    _MAX_ROWS = 100
    _lock = threading.Lock()
    _db_initialized = False

    def __init__(self):
        super().__init__()
        self._init_db()

    # ── Database helpers ─────────────────────────────────────────────────

    def _get_conn(self) -> sqlite3.Connection:
        """Create a new connection (sqlite3 connections are not thread-safe)."""
        conn = sqlite3.connect(self._DB_PATH, timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _init_db(self):
        """Create table if not exists."""
        if self._db_initialized:
            return
        os.makedirs(os.path.dirname(self._DB_PATH), exist_ok=True)
        try:
            with self._lock:
                conn = self._get_conn()
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS logs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        timestamp TEXT NOT NULL,
                        event_type TEXT NOT NULL,
                        call_id TEXT,
                        model TEXT,
                        duration_s REAL,
                        data TEXT NOT NULL
                    )
                """)
                conn.execute("""
                    CREATE INDEX IF NOT EXISTS idx_logs_event_type
                    ON logs(event_type)
                """)
                conn.execute("""
                    CREATE INDEX IF NOT EXISTS idx_logs_model
                    ON logs(model)
                """)
                conn.commit()
                conn.close()
                self._db_initialized = True
        except Exception as e:
            self._log_error(f"DB init error: {e}")

    def _write_record(self, record: dict):
        """Insert a record and enforce _MAX_ROWS limit."""
        try:
            # Serialize the full record to JSON
            try:
                data_json = json.dumps(record, ensure_ascii=False, default=str)
            except Exception as ve:
                safe = {k: (str(v) if k in ["request", "response"] else v)
                        for k, v in record.items()}
                data_json = json.dumps(safe, ensure_ascii=False, default=str)

            with self._lock:
                conn = self._get_conn()
                try:
                    conn.execute(
                        """INSERT INTO logs (timestamp, event_type, call_id, model, duration_s, data)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        (
                            record.get("timestamp", ""),
                            record.get("event_type", ""),
                            record.get("call_id"),
                            record.get("model"),
                            record.get("duration_s"),
                            data_json,
                        ),
                    )
                    # Enforce row limit: delete oldest rows beyond _MAX_ROWS
                    conn.execute(
                        """DELETE FROM logs WHERE id NOT IN (
                               SELECT id FROM logs ORDER BY id DESC LIMIT ?
                           )""",
                        (self._MAX_ROWS,),
                    )
                    conn.commit()
                finally:
                    conn.close()

        except Exception as e:
            self._log_error(f"Write error: {e}")

    def _log_error(self, msg: str):
        try:
            print(f"[raw_logger error] {msg}", flush=True)
            with open(self._ERROR_LOG, "a", encoding="utf-8") as ef:
                ef.write(f"{datetime.now(timezone.utc).isoformat()} [raw_logger] {msg}\n")
        except Exception:
            pass

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
        self._write_record(record)

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._print_response(kwargs, response_obj, start_time, end_time)

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._print_failure(kwargs, response_obj, start_time, end_time)

    # ── Async hooks (preferred by LiteLLM proxy) ────────────────────────
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        try:
            self._print_response(kwargs, response_obj, start_time, end_time)
        except Exception as e:
            self._log_error(f"async_log_success_event error: {e}")

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        try:
            self._print_failure(kwargs, response_obj, start_time, end_time)
        except Exception as e:
            self._log_error(f"async_log_failure_event error: {e}")

    # ── Printers ────────────────────────────────────────────────────────
    def _print_response(self, kwargs: dict, response_obj, start_time, end_time):
        # 使用 complete_streaming_response（如有），否则直接用 response_obj
        final_obj = kwargs.get("complete_streaming_response") or response_obj

        duration = (end_time - start_time).total_seconds() if start_time and end_time else 0

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
        self._write_record(record)

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
        self._write_record(record)


# Instantiate — referenced in litellm_config.yaml as raw_logger.raw_logger
raw_logger = RawLogger()
