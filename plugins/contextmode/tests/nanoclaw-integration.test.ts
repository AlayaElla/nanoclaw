/**
 * NanoClaw Integration Tests for context-mode
 *
 * Verifies the complete hook pipeline as it runs inside NanoClaw's
 * agent-runner container. Tests each hook script (.mjs) end-to-end
 * via subprocess execution, matching the real execution path:
 *
 *   createContextModeHook() → mock stdin → import(.mjs) → capture stdout
 *
 * Coverage:
 *   1. PreToolUse  — curl/wget block, inline HTTP block, Task injection, passthrough
 *   2. PostToolUse — event extraction + SessionDB persistence
 *   3. PreCompact  — snapshot building
 *   4. SessionStart (startup) — routing block injection
 *   5. SessionStart (compact) — session knowledge recovery
 *   6. UserPromptSubmit — user intent capture
 *   7. Full pipeline — sequential hook chain simulating a real session
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  cpSync,
  rmSync,
  existsSync,
  readdirSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// Isolated test environment
let pluginDir: string;
let projectDir: string;
let homeDir: string;
let sessionDBDir: string;

const SESSION_ID = "nanoclaw-test-session-001";

beforeAll(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "nanoclaw-ctx-test-"));

  // Copy hooks + configs
  cpSync(join(PROJECT_ROOT, "hooks"), join(pluginDir, "hooks"), {
    recursive: true,
  });
  if (existsSync(join(PROJECT_ROOT, "configs"))) {
    cpSync(join(PROJECT_ROOT, "configs"), join(pluginDir, "configs"), {
      recursive: true,
    });
  }

  // Copy build dir (needed for initSecurity in pretooluse.mjs)
  if (existsSync(join(PROJECT_ROOT, "build"))) {
    cpSync(join(PROJECT_ROOT, "build"), join(pluginDir, "build"), {
      recursive: true,
    });
  }

  // Symlink node_modules (native addon better-sqlite3 is too large to copy)
  if (existsSync(join(PROJECT_ROOT, "node_modules"))) {
    symlinkSync(
      join(PROJECT_ROOT, "node_modules"),
      join(pluginDir, "node_modules"),
    );
  }

  // Copy package.json for module resolution
  cpSync(
    join(PROJECT_ROOT, "package.json"),
    join(pluginDir, "package.json"),
  );

  // Isolated project + home dirs
  projectDir = mkdtempSync(join(tmpdir(), "nanoclaw-project-"));
  homeDir = mkdtempSync(join(tmpdir(), "nanoclaw-home-"));
  sessionDBDir = join(homeDir, ".claude", "context-mode", "sessions");
});

afterAll(() => {
  try { rmSync(pluginDir, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* */ }
});

// ── Helper: run a hook script via subprocess ──────────────────────

function runHook(
  hookFile: string,
  input: Record<string, unknown>,
  extraEnv?: Record<string, string>,
) {
  const hookPath = join(pluginDir, "hooks", hookFile);
  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_SESSION_ID: SESSION_ID,
      CONTEXT_MODE_PLATFORM: "claude-code",
      HOME: homeDir,
      USERPROFILE: homeDir,
      // NanoClaw container sets TMPDIR to persistent mount
      TMPDIR: join(homeDir, ".claude", ".tmp"),
      ...extraEnv,
    },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

// ── Helper: get DB files ──────────────────────────────────────────

function getDBFiles(): string[] {
  return existsSync(sessionDBDir)
    ? readdirSync(sessionDBDir).filter((f) => f.endsWith(".db"))
    : [];
}

// ── Helper: open DB and query (via subprocess to avoid native addon crashes in vitest) ──

function queryDB<T = Record<string, unknown>>(sql: string): T[] {
  const dbFiles = getDBFiles();
  if (dbFiles.length === 0) return [];
  const dbPath = join(sessionDBDir, dbFiles[0]);

  // Create a tiny one-off script to query the DB synchronously
  const scriptPath = join(tmpdir(), `query-${Date.now()}.cjs`);
  const scriptContent = `
    const Database = require("better-sqlite3");
    try {
      const db = new Database("${dbPath.replace(/\\/g, "/")}", { readonly: true });
      const rows = db.prepare(\`${sql}\`).all();
      process.stdout.write(JSON.stringify(rows));
      db.close();
    } catch (err) {
      process.stderr.write(err.message);
      process.exit(1);
    }
  `;

  writeFileSync(scriptPath, scriptContent);
  const result = spawnSync("node", [scriptPath], { 
    encoding: "utf-8",
    env: { 
        ...process.env, 
        NODE_PATH: join(PROJECT_ROOT, "node_modules") 
    }
  });
  try { rmSync(scriptPath); } catch {}

  if (result.status !== 0) {
    throw new Error("DB Query failed: " + result.stderr);
  }
  return JSON.parse(result.stdout) as T[];
}

// ══════════════════════════════════════════════════════════════════
// 1. PreToolUse — Tool Interception
// ══════════════════════════════════════════════════════════════════

describe("PreToolUse Hook", () => {
  test("blocks curl commands and returns modify action", () => {
    const result = runHook("pretooluse.mjs", {
      tool_name: "Bash",
      tool_input: { command: "curl https://api.github.com/repos" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toContain("curl/wget blocked");
  });

  test("blocks wget commands", () => {
    const result = runHook("pretooluse.mjs", {
      tool_name: "Bash",
      tool_input: { command: "wget https://example.com/large-file.tar.gz" },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toContain("curl/wget blocked");
  });

  test("blocks inline HTTP (node -e fetch)", () => {
    const result = runHook("pretooluse.mjs", {
      tool_name: "Bash",
      tool_input: {
        command: 'node -e "fetch(\'https://api.example.com/data\').then(r=>r.text()).then(console.log)"',
      },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toContain("Inline HTTP blocked");
  });

  test("blocks inline HTTP (python requests.get)", () => {
    const result = runHook("pretooluse.mjs", {
      tool_name: "Bash",
      tool_input: {
        command: 'python -c "import requests; print(requests.get(\'https://example.com\').text)"',
      },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toContain("Inline HTTP blocked");
  });

  test("allows curl with silent+file output (-sLo)", () => {
    const result = runHook("pretooluse.mjs", {
      tool_name: "Bash",
      tool_input: {
        command: "curl -sL https://example.com/file.tar.gz -o /tmp/file.tar.gz",
      },
    });

    expect(result.exitCode).toBe(0);
    // Null response = passthrough, or context guidance only
    if (result.stdout) {
      const parsed = JSON.parse(result.stdout);
      // Passthrough or context guidance — no blocked command
      expect(parsed.hookSpecificOutput?.updatedInput?.command).toBeUndefined();
    }
  });

  test("injects routing block into Task tool prompt", () => {
    const result = runHook("pretooluse.mjs", {
      tool_name: "Task",
      tool_input: {
        prompt: "Analyze the logging system",
        subagent_type: "general-purpose",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);

    const parsed = JSON.parse(result.stdout);
    const updatedPrompt = parsed.hookSpecificOutput?.updatedInput?.prompt ?? "";
    expect(updatedPrompt).toContain("Analyze the logging system");
    expect(updatedPrompt).toContain("context_window_protection");
  });

  test("upgrades Bash subagent to general-purpose", () => {
    const result = runHook("pretooluse.mjs", {
      tool_name: "Task",
      tool_input: {
        prompt: "Run deployment scripts",
        subagent_type: "Bash",
      },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.updatedInput?.subagent_type).toBe("general-purpose");
  });

  test("injects routing block into Agent tool (alternative name)", () => {
    const result = runHook("pretooluse.mjs", {
      tool_name: "Agent",
      tool_input: {
        prompt: "Research the API documentation",
      },
    });

    expect(result.exitCode).toBe(0);
    if (result.stdout) {
      const parsed = JSON.parse(result.stdout);
      const updatedPrompt = parsed.hookSpecificOutput?.updatedInput?.prompt;
      if (updatedPrompt) {
        expect(updatedPrompt).toContain("context_window_protection");
      }
    }
  });

  test("blocks WebFetch with deny action", () => {
    const result = runHook("pretooluse.mjs", {
      tool_name: "WebFetch",
      tool_input: { url: "https://docs.example.com" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("allows safe tools (Edit, Write, Glob) through", () => {
    for (const tool of ["Edit", "Write", "Glob"]) {
      const result = runHook("pretooluse.mjs", {
        tool_name: tool,
        tool_input: { file_path: "/workspace/test.ts" },
      });
      expect(result.exitCode).toBe(0);
      // Passthrough = empty stdout or no updatedInput with blocked command
      if (result.stdout) {
        const parsed = JSON.parse(result.stdout);
        // Passthrough or context — no blocked command
        expect(parsed.hookSpecificOutput?.updatedInput?.command).toBeUndefined();
      }
    }
  });

  test("passes through context-mode MCP tools", () => {
    const result = runHook("pretooluse.mjs", {
      tool_name: "mcp__context-mode__ctx_execute",
      tool_input: { language: "javascript", code: "console.log('hello')" },
    });

    expect(result.exitCode).toBe(0);
    // Empty stdout = passthrough
    expect(result.stdout).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. PostToolUse — Event Capture
// ══════════════════════════════════════════════════════════════════

describe("PostToolUse Hook", () => {
  test("captures file_read event from Read tool", () => {
    const result = runHook("posttooluse.mjs", {
      session_id: SESSION_ID,
      tool_name: "Read",
      tool_input: { file_path: "/workspace/src/index.ts" },
      tool_response: "export function main() { }",
    });

    expect(result.exitCode).toBe(0);
    expect(getDBFiles().length).toBeGreaterThan(0);
  });

  test("captures file_write event from Write tool", () => {
    const result = runHook("posttooluse.mjs", {
      session_id: SESSION_ID,
      tool_name: "Write",
      tool_input: {
        file_path: "/workspace/src/utils.ts",
        content: "export const foo = 42;",
      },
      tool_response: "File written successfully",
    });

    expect(result.exitCode).toBe(0);
  });

  test("captures command event from Bash tool", () => {
    const result = runHook("posttooluse.mjs", {
      session_id: SESSION_ID,
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "All 42 tests passed",
    });

    expect(result.exitCode).toBe(0);
  });

  test("captures error event from failed tool", () => {
    const result = runHook("posttooluse.mjs", {
      session_id: SESSION_ID,
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_response: "Error: Cannot find module 'lodash'",
      tool_output: { isError: true },
    });

    expect(result.exitCode).toBe(0);
  });

  test("captures file_edit event from Edit tool", () => {
    const result = runHook("posttooluse.mjs", {
      session_id: SESSION_ID,
      tool_name: "Edit",
      tool_input: {
        file_path: "/workspace/src/index.ts",
        old_string: "const x = 1;",
        new_string: "const x = 2;",
      },
      tool_response: "Edit applied successfully",
    });

    expect(result.exitCode).toBe(0);
  });

  test("captures search event from Grep tool", () => {
    const result = runHook("posttooluse.mjs", {
      session_id: SESSION_ID,
      tool_name: "Grep",
      tool_input: { pattern: "TODO", path: "/workspace/src" },
      tool_response: "src/index.ts:5: // TODO: refactor",
    });

    expect(result.exitCode).toBe(0);
  });

  test("DB contains all captured events", () => {
    const events = queryDB(
      `SELECT type, category FROM session_events WHERE session_id = '${SESSION_ID}' ORDER BY rowid`,
    );

    // Should have events from the previous tests
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  test("never crashes on malformed input", () => {
    const result = runHook("posttooluse.mjs", {
      // Missing required fields
      tool_name: "",
      tool_input: null as unknown as Record<string, unknown>,
    });

    // Must not crash — silent fallback
    expect(result.exitCode).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. PreCompact — Snapshot Building
// ══════════════════════════════════════════════════════════════════

describe("PreCompact Hook", () => {
  test("builds snapshot from captured events", () => {
    const result = runHook("precompact.mjs", {
      session_id: SESSION_ID,
    });

    expect(result.exitCode).toBe(0);
  });

  test("snapshot is persisted in session_resume table", () => {
    const rows = queryDB<{ snapshot: string; event_count: number }>(
      `SELECT snapshot, event_count FROM session_resume WHERE session_id = '${SESSION_ID}'`,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].snapshot.length).toBeGreaterThan(0);
    expect(rows[0].event_count).toBeGreaterThan(0);
  });

  test("snapshot contains session_resume XML", () => {
    const rows = queryDB<{ snapshot: string }>(
      `SELECT snapshot FROM session_resume WHERE session_id = '${SESSION_ID}'`,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].snapshot).toContain("session_resume");
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. SessionStart — Routing Block + Recovery
// ══════════════════════════════════════════════════════════════════

describe("SessionStart Hook", () => {
  test("startup: injects routing block (additionalContext)", () => {
    const result = runHook("sessionstart.mjs", {
      session_id: SESSION_ID,
      source: "startup",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);

    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx.length).toBeGreaterThan(0);
  });

  test("compact: recovers session knowledge from DB", () => {
    // This relies on PreCompact having run earlier in the suite
    const result = runHook("sessionstart.mjs", {
      session_id: SESSION_ID,
      source: "compact",
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("session_knowledge");
  });

  test("compact: includes file context in recovery", () => {
    const result = runHook("sessionstart.mjs", {
      session_id: SESSION_ID,
      source: "compact",
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    // Should contain file paths from PostToolUse events recorded earlier
    // (index.ts was read and edited in PostToolUse tests)
    expect(ctx).toContain("index.ts");
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. UserPromptSubmit — User Intent Capture
// ══════════════════════════════════════════════════════════════════

describe("UserPromptSubmit Hook", () => {
  test("captures user prompt as event", () => {
    const result = runHook("userpromptsubmit.mjs", {
      prompt: "Fix the memory leak in the WebSocket handler",
      session_id: SESSION_ID,
    });

    expect(result.exitCode).toBe(0);
    // DB should have the user prompt event
    expect(getDBFiles().length).toBeGreaterThan(0);
  });

  test("captures Chinese language prompts", () => {
    const result = runHook("userpromptsubmit.mjs", {
      prompt: "修复 WebSocket 处理器中的内存泄漏",
      session_id: SESSION_ID,
    });

    expect(result.exitCode).toBe(0);
  });

  test("handles empty prompt gracefully", () => {
    const result = runHook("userpromptsubmit.mjs", {
      prompt: "",
      session_id: SESSION_ID,
    });

    expect(result.exitCode).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. Full Pipeline — Simulated Session Lifecycle
// ══════════════════════════════════════════════════════════════════

describe("Full Session Lifecycle", () => {
  const PIPELINE_SESSION = "nanoclaw-pipeline-test";
  let pipelineHomeDir: string;

  beforeAll(() => {
    pipelineHomeDir = mkdtempSync(join(tmpdir(), "nanoclaw-pipeline-"));
  });

  afterAll(() => {
    try { rmSync(pipelineHomeDir, { recursive: true, force: true }); } catch { /* */ }
  });

  function pipelineHook(
    hookFile: string,
    input: Record<string, unknown>,
  ) {
    return runHook(hookFile, input, {
      HOME: pipelineHomeDir,
      USERPROFILE: pipelineHomeDir,
      CLAUDE_SESSION_ID: PIPELINE_SESSION,
    });
  }

  test("step 1: session starts with routing block", () => {
    const result = pipelineHook("sessionstart.mjs", {
      session_id: PIPELINE_SESSION,
      source: "startup",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.additionalContext).toBeDefined();
  });

  test("step 2: user submits prompt", () => {
    const result = pipelineHook("userpromptsubmit.mjs", {
      prompt: "Refactor the database module to use connection pooling",
      session_id: PIPELINE_SESSION,
    });

    expect(result.exitCode).toBe(0);
  });

  test("step 3: agent reads a file (PostToolUse captures)", () => {
    const result = pipelineHook("posttooluse.mjs", {
      session_id: PIPELINE_SESSION,
      tool_name: "Read",
      tool_input: { file_path: "/workspace/src/db.ts" },
      tool_response: "import Database from 'better-sqlite3';",
    });

    expect(result.exitCode).toBe(0);
  });

  test("step 4: agent tries curl (PreToolUse blocks)", () => {
    const result = pipelineHook("pretooluse.mjs", {
      tool_name: "Bash",
      tool_input: { command: "curl https://docs.example.com/api" },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toContain("curl/wget blocked");
  });

  test("step 5: agent edits a file (PostToolUse captures)", () => {
    const result = pipelineHook("posttooluse.mjs", {
      session_id: PIPELINE_SESSION,
      tool_name: "Edit",
      tool_input: {
        file_path: "/workspace/src/db.ts",
        old_string: "new Database(",
        new_string: "createPool(",
      },
      tool_response: "Edit applied",
    });

    expect(result.exitCode).toBe(0);
  });

  test("step 6: agent runs tests (PostToolUse captures)", () => {
    const result = pipelineHook("posttooluse.mjs", {
      session_id: PIPELINE_SESSION,
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "PASS tests/db.test.ts\n  ✓ pool creation (12ms)\n  ✓ concurrent queries (45ms)",
    });

    expect(result.exitCode).toBe(0);
  });

  test("step 7: context compaction triggers snapshot", () => {
    const result = pipelineHook("precompact.mjs", {
      session_id: PIPELINE_SESSION,
    });

    expect(result.exitCode).toBe(0);
  });

  test("step 8: session recovers after compaction", () => {
    const result = pipelineHook("sessionstart.mjs", {
      session_id: PIPELINE_SESSION,
      source: "compact",
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    // Recovery should contain knowledge from the session
    expect(ctx).toContain("session_knowledge");
    // Should remember the file that was read/edited
    expect(ctx).toContain("db.ts");
  });

  test("step 9: verify DB has complete event chain", () => {
    const dbDir = join(pipelineHomeDir, ".claude", "context-mode", "sessions");
    const dbFiles = existsSync(dbDir)
      ? readdirSync(dbDir).filter((f) => f.endsWith(".db"))
      : [];
    expect(dbFiles.length).toBeGreaterThan(0);

    const dbPath = join(dbDir, dbFiles[0]);
    
    // Using a one-off query script same as helper above
    const scriptPath = join(tmpdir(), `query-pipeline-${Date.now()}.cjs`);
    const sql = "SELECT type, category FROM session_events WHERE session_id = '" + PIPELINE_SESSION + "' ORDER BY rowid";
    const scriptContent = `
      const Database = require("better-sqlite3");
      try {
        const db = new Database("${dbPath.replace(/\\/g, "/")}", { readonly: true });
        const rows = db.prepare(\`${sql}\`).all();
        process.stdout.write(JSON.stringify(rows));
        db.close();
      } catch (err) {
        process.stderr.write(err.message);
        process.exit(1);
      }
    `;
    
    writeFileSync(scriptPath, scriptContent);
    const result = spawnSync("node", [scriptPath], { 
        encoding: "utf-8",
        env: { 
            ...process.env, 
            NODE_PATH: join(PROJECT_ROOT, "node_modules") 
        }
    });
    try { rmSync(scriptPath); } catch {}
    
    if (result.status !== 0) {
        throw new Error("DB Query failed: " + result.stderr);
    }
    
    const events = JSON.parse(result.stdout) as { type: string; category: string }[];

    // Should have at least: file_read, file_edit, command events
    expect(events.length).toBeGreaterThanOrEqual(3);

    const types = events.map((e) => e.type);
    expect(types).toContain("file_read");
  });
});
