import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function collectHookShellScripts(dir: string): string[] {
  const results: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectHookShellScripts(fullPath));
      continue;
    }

    if (
      entry.isFile() &&
      entry.name.endsWith('.sh') &&
      fullPath.includes(`${path.sep}hooks${path.sep}`)
    ) {
      results.push(fullPath);
    }
  }

  return results;
}

describe('hook shell scripts', () => {
  it('use LF line endings so Linux direct exec keeps the shebang valid', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const scripts = collectHookShellScripts(
      path.join(repoRoot, 'container', 'skills'),
    );

    expect(scripts.length).toBeGreaterThan(0);

    for (const scriptPath of scripts) {
      const bytes = fs.readFileSync(scriptPath);
      const hasCrLf = bytes.some(
        (_byte, index) =>
          index < bytes.length - 1 &&
          bytes[index] === 0x0d &&
          bytes[index + 1] === 0x0a,
      );

      expect(hasCrLf).toBe(false);
    }
  });
});
