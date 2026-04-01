const fs = require('fs');
const content = fs.readFileSync('/home/alaya/CodeSpace/nanoclaw/container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts', 'utf8');
const lines = content.split('\n');
lines.forEach((l, i) => { if (l.includes('dispatch') || l.includes('trigger') || l.includes('runHook')) console.log(l.trim()); });
