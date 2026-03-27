"""
LiteLLM Custom Callback – 原始 Input / Output 日志 + Token Spend 追踪
将请求体和响应体以 raw JSON 形式输出到容器 stdout，
同时将每次请求的 Token 用量写入 SQLite 数据库 (spend.db)。
"""

import json
import sqlite3
import os
from datetime import datetime, timezone

import litellm
from litellm.integrations.custom_logger import CustomLogger


class RawLogger(CustomLogger):
    """Log raw request/response payloads and track token spend."""

    _SEP = "=" * 72
    _LOG_FILE = "/app/litellm.log"
    _SPEND_DB = "/app/spend.db"

    def __init__(self):
        super().__init__()
        self._init_spend_db()

    # ── Spend DB ─────────────────────────────────────────────────────────

    def _init_spend_db(self):
        """Create the spend tracking table if it doesn't exist."""
        try:
            conn = sqlite3.connect(self._SPEND_DB)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS spend_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    model TEXT NOT NULL,
                    prompt_tokens INTEGER DEFAULT 0,
                    completion_tokens INTEGER DEFAULT 0,
                    total_tokens INTEGER DEFAULT 0,
                    duration_s REAL DEFAULT 0,
                    status TEXT DEFAULT 'success'
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_spend_timestamp
                ON spend_logs(timestamp)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_spend_model
                ON spend_logs(model)
            """)
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[spend-db] init error: {e}", flush=True)

    def _record_spend(self, model, response_obj, start_time, end_time, status="success"):
        """Extract token usage from response and write to spend.db."""
        try:
            prompt_tokens = 0
            completion_tokens = 0
            total_tokens = 0

            # Extract usage from response object
            if hasattr(response_obj, "usage") and response_obj.usage:
                usage = response_obj.usage
                prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
                completion_tokens = getattr(usage, "completion_tokens", 0) or 0
                total_tokens = getattr(usage, "total_tokens", 0) or 0
            elif hasattr(response_obj, "model_dump"):
                resp_dict = response_obj.model_dump()
                usage = resp_dict.get("usage", {})
                if usage:
                    prompt_tokens = usage.get("prompt_tokens", 0) or 0
                    completion_tokens = usage.get("completion_tokens", 0) or 0
                    total_tokens = usage.get("total_tokens", 0) or 0

            if total_tokens == 0 and (prompt_tokens + completion_tokens) > 0:
                total_tokens = prompt_tokens + completion_tokens

            duration_s = (end_time - start_time).total_seconds() if start_time and end_time else 0
            ts = datetime.now(timezone.utc).isoformat()

            conn = sqlite3.connect(self._SPEND_DB)
            conn.execute(
                """INSERT INTO spend_logs
                   (timestamp, model, prompt_tokens, completion_tokens, total_tokens, duration_s, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (ts, str(model), prompt_tokens, completion_tokens, total_tokens, round(duration_s, 3), status),
            )
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[spend-db] write error: {e}", flush=True)

    # ── File logging helper ──────────────────────────────────────────────

    def _write_to_file(self, content):
        try:
            with open(self._LOG_FILE, "a", encoding="utf-8") as f:
                f.write(content + "\n")
        except Exception as e:
            print("Error writing to log file: " + str(e))

    @staticmethod
    def _dump(obj) -> str:
        try:
            return json.dumps(obj, ensure_ascii=False, indent=2, default=str)
        except Exception:
            return str(obj)

    # ── Sync hooks (fallback) ───────────────────────────────────────────
    def log_pre_api_call(self, model, messages, kwargs):
        output = []
        output.append("\n" + self._SEP)
        output.append("📤 RAW INPUT  |  model=" + str(model))
        output.append(self._SEP)
        output.append(self._dump(messages))

        optional = kwargs.get("optional_params", {})
        if optional:
            output.append("\n── optional_params ──")
            output.append(self._dump(optional))

        output.append(self._SEP)
        final_output = "\n".join(output)
        print(final_output, flush=True)
        self._write_to_file(final_output)

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._print_response(kwargs, response_obj, start_time, end_time)
        self._record_spend(kwargs.get("model", "?"), response_obj, start_time, end_time, "success")

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._print_failure(kwargs, response_obj, start_time, end_time)
        self._record_spend(kwargs.get("model", "?"), response_obj, start_time, end_time, "error")

    # ── Async hooks (preferred by LiteLLM proxy) ────────────────────────
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._print_response(kwargs, response_obj, start_time, end_time)
        self._record_spend(kwargs.get("model", "?"), response_obj, start_time, end_time, "success")

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._print_failure(kwargs, response_obj, start_time, end_time)
        self._record_spend(kwargs.get("model", "?"), response_obj, start_time, end_time, "error")

    # ── Printers ────────────────────────────────────────────────────────
    def _print_response(self, kwargs: dict, response_obj, start_time, end_time):
        model = kwargs.get("model", "?")
        messages = kwargs.get("messages", None)

        output = []
        output.append(f"\n{self._SEP}")
        output.append(f"📥 RAW OUTPUT  |  model={model}  |  ⏱ {end_time - start_time}")
        output.append(self._SEP)

        # Print input messages
        output.append("── input messages ──")
        output.append(self._dump(messages))

        # Find and print system prompt
        found_system = False
        for key in ['input', 'additional_args']:
            val = kwargs.get(key, None)
            if val and isinstance(val, dict) and 'system' in val:
                output.append(f"\n── system prompt (from kwargs['{key}']['system'], first 3000 chars) ──")
                s = val['system']
                output.append(str(s)[:3000])
                found_system = True
                break
        if not found_system:
            if messages and isinstance(messages[0], dict) and messages[0].get("role") == "system":
                output.append("\n── system prompt (from messages[0]) ──")
                output.append(str(messages[0].get("content", ""))[:3000])
            else:
                output.append("\n── system prompt: NOT FOUND ──")

        # Print extra_body
        extra_body = kwargs.get("optional_params", {}).get("extra_body", {})
        if extra_body:
            output.append("\n── extra_body ──")
            output.append(self._dump(extra_body))

        # Print full response
        output.append("\n── response ──")
        resp = response_obj.model_dump() if hasattr(response_obj, "model_dump") else response_obj
        output.append(self._dump(resp))

        output.append(self._SEP)
        final_output = "\n".join(output)
        print(final_output, flush=True)
        self._write_to_file(final_output)

    def _print_failure(self, kwargs: dict, response_obj, start_time, end_time):
        model = kwargs.get("model", "?")
        output = []
        output.append(f"\n{self._SEP}")
        output.append(f"❌ RAW FAILURE  |  model={model}  |  ⏱ {end_time - start_time}")
        output.append(self._SEP)
        output.append(self._dump({
            "error": str(response_obj),
            "exception": str(kwargs.get("exception", "")),
        }))
        output.append(self._SEP)
        final_output = "\n".join(output)
        print(final_output, flush=True)
        self._write_to_file(final_output)


# Instantiate — referenced in litellm_config.yaml as raw_logger.raw_logger
raw_logger = RawLogger()
