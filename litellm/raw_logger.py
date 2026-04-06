"""
LiteLLM Custom Callback – 原始 Input / Output 日志
将请求体和响应体以 raw JSON 形式输出到容器 stdout，
并保存为 jsonl 格式。
"""

import json
import os
import subprocess
import threading
from datetime import datetime, timezone

import litellm
from litellm.integrations.custom_logger import CustomLogger

class RawLogger(CustomLogger):
    """Log raw request/response payloads to jsonl."""

    _LOG_FILE = "/app/litellm.jsonl"
    _ERROR_LOG = "/app/raw_logger_error.log"
    _MAX_LINES = 50
    # 当行数超过此阈值时触发截断（留一些余量，避免每次写入都截断）
    _TRUNCATE_THRESHOLD = _MAX_LINES + 10
    _lock = threading.Lock()
    _line_count = -1  # -1 表示尚未初始化

    def __init__(self):
        super().__init__()

    # ── File logging helpers ─────────────────────────────────────────────

    def _get_line_count(self) -> int:
        """获取文件当前行数（仅在首次调用时读取文件，之后靠内存计数器）。"""
        if self._line_count < 0:
            try:
                if os.path.exists(self._LOG_FILE):
                    result = subprocess.run(
                        ["wc", "-l", self._LOG_FILE],
                        capture_output=True, text=True, timeout=5
                    )
                    self._line_count = int(result.stdout.strip().split()[0])
                else:
                    self._line_count = 0
            except Exception:
                self._line_count = 0
        return self._line_count

    def _truncate_file(self):
        """使用 tail 命令高效截断文件到 _MAX_LINES 行。"""
        try:
            tmp_file = self._LOG_FILE + ".tmp"
            subprocess.run(
                ["sh", "-c", f'tail -n {self._MAX_LINES} "{self._LOG_FILE}" > "{tmp_file}" && mv "{tmp_file}" "{self._LOG_FILE}"'],
                timeout=30
            )
            self._line_count = self._MAX_LINES
        except Exception as e:
            # 截断失败不影响写入
            with open(self._ERROR_LOG, "a", encoding="utf-8") as ef:
                ef.write(f"{datetime.now(timezone.utc).isoformat()} [raw_logger] Truncate error: {str(e)}\n")

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

            with self._lock:
                # 追加写入（O(1) 操作，不需要读取整个文件）
                with open(self._LOG_FILE, "a", encoding="utf-8") as f:
                    f.write(line + "\n")

                # 更新行数计数器
                count = self._get_line_count() + 1
                self._line_count = count

                # 超过阈值时截断
                if count > self._TRUNCATE_THRESHOLD:
                    self._truncate_file()

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
        # 跳过中间 stream chunk，只记录最终完整响应
        is_streaming = kwargs.get("stream", False)
        final_obj = kwargs.get("complete_streaming_response")

        if is_streaming and final_obj is None:
            # 这是一个中间 stream chunk，跳过
            return

        if final_obj is None:
            final_obj = response_obj

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
