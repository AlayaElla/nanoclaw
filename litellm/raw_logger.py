"""
LiteLLM Custom Callback – 原始 Input / Output 日志
将请求体和响应体以 raw JSON 形式输出到容器 stdout，
方便通过 `docker logs -f nanoclaw-litellm-proxy` 实时查看。
"""

import json
import litellm
from litellm.integrations.custom_logger import CustomLogger


class RawLogger(CustomLogger):
    """Log raw request/response payloads for every LLM call."""

    _SEP = "=" * 72

    # ── Helper ──────────────────────────────────────────────────────────
    @staticmethod
    def _dump(obj):
        try:
            return json.dumps(obj, ensure_ascii=False, indent=2, default=str)
        except Exception:
            return str(obj)

    # ── Sync hooks (fallback) ───────────────────────────────────────────
    def log_pre_api_call(self, model, messages, kwargs):
        print(f"\n{self._SEP}")
        print(f"📤 RAW INPUT  |  model={model}")
        print(self._SEP)
        print(self._dump(messages))

        optional = kwargs.get("optional_params", {})
        if optional:
            print(f"\n── optional_params ──")
            print(self._dump(optional))

        print(self._SEP, flush=True)

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
    def _print_response(self, kwargs, response_obj, start_time, end_time):
        model = kwargs.get("model", "?")
        messages = kwargs.get("messages", None)

        print(f"\n{self._SEP}")
        print(f"📥 RAW OUTPUT  |  model={model}  |  ⏱ {end_time - start_time}")
        print(self._SEP)

        # Print input messages
        print("── input messages ──")
        print(self._dump(messages))

        # Find and print system prompt
        # LiteLLM may store it in 'input' (full API payload) or 'additional_args'
        found_system = False
        for key in ['input', 'additional_args']:
            val = kwargs.get(key, None)
            if val and isinstance(val, dict) and 'system' in val:
                print(f"\n── system prompt (from kwargs['{key}']['system'], first 3000 chars) ──")
                s = val['system']
                print(str(s)[:3000])
                found_system = True
                break
        if not found_system:
            # Try messages[0] with role=system
            if messages and isinstance(messages[0], dict) and messages[0].get("role") == "system":
                print("\n── system prompt (from messages[0]) ──")
                print(str(messages[0].get("content", ""))[:3000])
            else:
                print("\n── system prompt: NOT FOUND ──")

        # Print extra_body (e.g. enable_thinking) if present
        extra_body = kwargs.get("optional_params", {}).get("extra_body", {})
        if extra_body:
            print("\n── extra_body ──")
            print(self._dump(extra_body))

        # Print full response
        print("\n── response ──")
        resp = response_obj.model_dump() if hasattr(response_obj, "model_dump") else response_obj
        print(self._dump(resp))

        print(self._SEP, flush=True)

    def _print_failure(self, kwargs, response_obj, start_time, end_time):
        model = kwargs.get("model", "?")
        print(f"\n{self._SEP}")
        print(f"❌ RAW FAILURE  |  model={model}  |  ⏱ {end_time - start_time}")
        print(self._SEP)
        print(self._dump({
            "error": str(response_obj),
            "exception": str(kwargs.get("exception", "")),
        }))
        print(self._SEP, flush=True)


# Instantiate — referenced in litellm_config.yaml as litellm_raw_logger.raw_logger
raw_logger = RawLogger()
