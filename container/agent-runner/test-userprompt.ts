import { query } from '@anthropic-ai/claude-agent-sdk';

const msgStream = (async function*() {
  const d1 = {
    type: 'user',
    message: { role: 'user', content: 'hello' },
    parent_tool_use_id: null,
    session_id: '',
  };
  console.log("Yielding msg 1");
  yield d1;
  await new Promise(r => setTimeout(r, 1000));
  const d2 = {
    type: 'user',
    message: { role: 'user', content: 'test user submit' },
    parent_tool_use_id: null,
    session_id: '',
  };
  console.log("Yielding msg 2");
  yield d2;
})();

async function main() {
  const iterable = query({
    prompt: msgStream as any,
    hooks: {
      UserPromptSubmit: [{
        matcher: '',
        hooks: [async (input) => {
          console.log('UserPromptSubmit Triggered:', JSON.stringify(input));
          return { hookEventName: 'UserPromptSubmit' } as any;
        }]
      }]
    }
  });

  for await (const message of iterable) {
    if (message.type === 'assistant') {
      console.log('Assistant:', message);
    }
  }
}

main().catch(console.error);
