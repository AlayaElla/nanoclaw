# Control Center Logger Panel Design

**Date:** 2026-04-04
**Topic:** Dashboard Logger (`litellm.jsonl` reader)

## 1. Overview
The goal is to add a dedicated "Logger" panel to the NanoClaw Control Center (`cc`). This panel will parse and display the API interaction logs stored in `litellm/litellm.jsonl`. Since the JSONL file is capped at ~20 lines dynamically, frontend and backend parsing efficiency concerns are minimal.

## 2. Architecture & Routing
- **Backend API Routes:**
  - `GET /cc/?section=logger` : Serve the initial HTML layout through `control-center.ts`.
  - `GET /api/logs/litellm` : HTMX polling endpoint that parses `litellm.jsonl`, applies user filters, and returns HTML snippet for table rows.
- **Frontend Components:**
  - Placed in `src/web/pages/LoggerPage.ts`.
  - Added to the `SECTIONS` array in `src/web/types.ts`.
  - Navigation tab added to `src/web/components/Layout.ts`.

## 3. User Interface (UI)
- **Top Control Bar:**
  - Filter `event_type` (e.g., `pre_api_call`, `post_api_call`).
  - Filter `model`.
  - Filters auto-trigger HTMX re-renders (`hx-trigger="change"`).
- **Log Table:**
  - Utilizes HTMX auto-polling (`hx-trigger="every 5s"`).
  - Main row elements: Timestamp, Event Type, Model Name, Call ID.
  - Interactive "Details" button that expands an inline preview of JSON payloads (e.g., the `request` and `response` structures).

## 4. Error Handling
- If `litellm.jsonl` does not exist or is malformed, display a friendly "No logs found or unable to parse" alert in the UI instead of throwing an unhandled exception.

## 5. Security
- Log panel requires the exact same Bearer/cookie authentication `GATEWAY_AUTH_TOKEN` already enforced by the Control Center.
- File system access is tightly scoped to `litellm/litellm.jsonl` to avoid arbitrary file read vulnerabilities.
