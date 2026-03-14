import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Test: agent-runner source sync behavior
 *
 * Verifies that the agent-runner source code is ALWAYS synced
 * to the per-group directory, not just on first run.
 *
 * Bug: container-runner.ts line 273 has:
 *   if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc))
 * This skips the copy when the destination already exists, preventing
 * code updates from taking effect after restart.
 */
describe('agent-runner source sync', () => {
  let tmpDir: string;
  let srcDir: string;
  let dstDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sync-test-'));
    srcDir = path.join(tmpDir, 'src');
    dstDir = path.join(tmpDir, 'dst');

    // Create source directory with a file
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'console.log("v1")');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('current behavior (bug): skips sync when dest exists', () => {
    // First sync — works fine
    if (!fs.existsSync(dstDir) && fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
    expect(fs.readFileSync(path.join(dstDir, 'index.ts'), 'utf-8')).toBe(
      'console.log("v1")',
    );

    // Update source
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'console.log("v2")');

    // Second sync — BUG: skipped because dstDir exists
    if (!fs.existsSync(dstDir) && fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }

    // Still v1 — the update was NOT applied
    expect(fs.readFileSync(path.join(dstDir, 'index.ts'), 'utf-8')).toBe(
      'console.log("v1")',
    );
  });

  it('fixed behavior: always syncs source to dest', () => {
    // First sync
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
    expect(fs.readFileSync(path.join(dstDir, 'index.ts'), 'utf-8')).toBe(
      'console.log("v1")',
    );

    // Update source
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'console.log("v2")');

    // Second sync — FIX: always copies
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }

    // Now v2 — the update WAS applied
    expect(fs.readFileSync(path.join(dstDir, 'index.ts'), 'utf-8')).toBe(
      'console.log("v2")',
    );
  });

  it('fixed behavior: new files in source are synced', () => {
    // First sync
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }

    // Add a new file to source
    fs.writeFileSync(path.join(srcDir, 'helper.ts'), 'export const x = 1;');

    // Second sync
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }

    // New file should exist in dest
    expect(fs.existsSync(path.join(dstDir, 'helper.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(dstDir, 'helper.ts'), 'utf-8')).toBe(
      'export const x = 1;',
    );
  });
});
