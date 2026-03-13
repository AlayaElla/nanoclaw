import * as Lark from '@larksuiteoapi/node-sdk';
import { FeishuContentConverter } from '../src/channels/feishu.js';

// Mock Lark Client
const mockClient = {} as Lark.Client;
const resolveSenderName = async (id: string) => `MockUser_${id}`;

const converter = new FeishuContentConverter(mockClient, resolveSenderName);

async function testText() {
  const msg = {
    message_id: 'om_123',
    message_type: 'text',
    content: JSON.stringify({ text: 'Hello <at user_id="ou_123">@Bot</at>!' }),
    mentions: [{ id: { open_id: 'ou_123' }, name: 'Bot' }]
  };
  const mentions = [{ id: 'ou_123', name: 'Bot' }];
  const ctx = await converter.convert(msg, mentions);
  console.log('Testing Text:');
  console.log('Result:', ctx.content);
  if (ctx.content === 'Hello @Bot!') {
    console.log('✅ Pass');
  } else {
    console.log('❌ Fail');
  }
}

async function testPost() {
  const msg = {
    message_id: 'om_456',
    message_type: 'post',
    content: JSON.stringify({
      title: 'Post Title',
      content: [
        [
          { tag: 'text', text: 'Hello ' },
          { tag: 'at', user_id: 'ou_123' },
          { tag: 'text', text: '\nLine 2' }
        ],
        [
          { tag: 'a', text: 'Google', href: 'https://google.com' }
        ]
      ]
    }),
    mentions: [{ id: { open_id: 'ou_123' }, name: 'Bot' }]
  };
  const mentions = [{ id: 'ou_123', name: 'Bot' }];
  const ctx = await converter.convert(msg, mentions);
  console.log('\nTesting Post:');
  console.log('Result:\n', ctx.content);
  if (ctx.content.includes('**Post Title**') && ctx.content.includes('Hello @Bot') && ctx.content.includes('[Google](https://google.com)')) {
    console.log('✅ Pass');
  } else {
    console.log('❌ Fail');
  }
}

async function testInteractive() {
  const msg = {
    message_id: 'om_789',
    message_type: 'interactive',
    content: JSON.stringify({
      header: { title: { content: 'Card Header' } },
      elements: [
        { tag: 'plain_text', content: 'Card body text' }
      ]
    })
  };
  const ctx = await converter.convert(msg, []);
  console.log('\nTesting Interactive:');
  console.log('Result:', ctx.content);
  if (ctx.content.includes('**Card Header**') && ctx.content.includes('Card body text')) {
    console.log('✅ Pass');
  } else {
    console.log('❌ Fail');
  }
}

async function runTests() {
  try {
    await testText();
    await testPost();
    await testInteractive();
    // testMergeForward requires deeper mocking, skipping for now
  } catch (err) {
    console.error('Test run failed:', err);
  }
}

runTests();
