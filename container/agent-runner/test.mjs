import { query } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  for await (const message of query({
    prompt: "Evaluate 1+1 using the Bash tool and print the raw result",
    options: {
      allowedTools: ['Bash'],
    }
  })) {
    console.log(`TYPE: ${message.type}`);
    if (message.type === 'assistant') {
      const msg = message as any;
      console.log('CONTENT:', JSON.stringify(msg.message.content, null, 2));
    }
    if (message.type === 'stream_event') {
      console.log('STREAM EVENT:', JSON.stringify(message, null, 2));
    }
    if (message.type === 'tool_progress') {
      console.log('TOOL PROGRESS:', JSON.stringify(message, null, 2));
    }
  }
}

main().catch(console.error);
