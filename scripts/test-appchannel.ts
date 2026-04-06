/**
 * AppChannel 连通性测试脚本
 *
 * 测试流程:
 *   1. WebSocket 连接到 Gateway /ws/app
 *   2. 发送 auth 消息 (deviceId + token)
 *   3. 验证 auth_result.success === true
 *   4. 发送一条测试消息
 *   5. 验证收到 ack
 *   6. 等待可能返回的 bot 响应 (typing / message / status)
 *
 * 用法:
 *   npx tsx scripts/test-appchannel.ts [--port 18790] [--token xxx] [--device test_device]
 */

import { WebSocket } from 'ws';
import { config } from 'dotenv';
import path from 'path';

// Load .env from project root
config({ path: path.resolve(import.meta.dirname || __dirname, '..', '.env') });

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const PORT = getArg('port', process.env.GATEWAY_PORT || '18790');
const TOKEN = getArg('token', process.env.GATEWAY_AUTH_TOKEN || '');
const DEVICE_ID = getArg('device', `test_${Date.now()}`);
const MESSAGE = getArg('message', '你好，这是一条 AppChannel 连通性测试消息 🧪');
const TIMEOUT_MS = parseInt(getArg('timeout', '15000'), 10);

const WS_URL = `ws://127.0.0.1:${PORT}/ws/app`;

// --- Helpers ---
const FG = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function log(icon: string, ...msg: unknown[]) {
  console.log(`  ${icon}`, ...msg);
}

// --- Test ---
interface TestResult {
  connected: boolean;
  authenticated: boolean;
  messageSent: boolean;
  ackReceived: boolean;
  botResponded: boolean;
  errors: string[];
}

async function runTest(): Promise<TestResult> {
  const result: TestResult = {
    connected: false,
    authenticated: false,
    messageSent: false,
    ackReceived: false,
    botResponded: false,
    errors: [],
  };

  console.log();
  console.log(FG.cyan('╔══════════════════════════════════════════╗'));
  console.log(FG.cyan('║    AppChannel Connectivity Test          ║'));
  console.log(FG.cyan('╚══════════════════════════════════════════╝'));
  console.log();
  log('🔗', `URL:       ${WS_URL}`);
  log('🔑', `Token:     ${TOKEN.slice(0, 8)}...`);
  log('📱', `DeviceID:  ${DEVICE_ID}`);
  log('⏱️ ', `Timeout:   ${TIMEOUT_MS}ms`);
  console.log();

  return new Promise<TestResult>((resolve) => {
    const timer = setTimeout(() => {
      log('⏱️ ', FG.yellow('Timeout reached, closing connection'));
      ws.close();
      resolve(result);
    }, TIMEOUT_MS);

    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err: any) {
      result.errors.push(`Failed to create WebSocket: ${err.message}`);
      log('❌', FG.red(`WebSocket creation failed: ${err.message}`));
      clearTimeout(timer);
      resolve(result);
      return;
    }

    ws.on('open', () => {
      result.connected = true;
      log('✅', FG.green('WebSocket connected'));

      // Step 2: Send auth
      const authPayload = {
        type: 'auth',
        deviceId: DEVICE_ID,
        token: TOKEN,
      };
      log('📤', 'Sending auth...', FG.dim(JSON.stringify(authPayload)));
      ws.send(JSON.stringify(authPayload));
    });

    ws.on('message', (data: Buffer) => {
      const raw = data.toString();
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        log('⚠️ ', FG.yellow(`Non-JSON message: ${raw}`));
        return;
      }

      switch (msg.type) {
        case 'auth_result':
          if (msg.success) {
            result.authenticated = true;
            log('✅', FG.green(`Authenticated! JID = ${msg.jid}`));

            // Step 4: Send test message
            const msgPayload = { type: 'message', content: MESSAGE };
            log('📤', `Sending message: "${MESSAGE}"`);
            ws.send(JSON.stringify(msgPayload));
            result.messageSent = true;
          } else {
            result.errors.push(`Auth failed: ${msg.reason}`);
            log('❌', FG.red(`Auth failed: ${msg.reason}`));
            clearTimeout(timer);
            ws.close();
            resolve(result);
          }
          break;

        case 'ack':
          result.ackReceived = true;
          log('✅', FG.green(`ACK received (messageId: ${msg.messageId})`));
          log('⏳', FG.dim('Waiting for bot response...'));
          break;

        case 'typing':
          log('💬', FG.dim(`Typing indicator: ${msg.isTyping ? 'started' : 'stopped'}`));
          break;

        case 'status':
          log('📊', FG.yellow(`Status: ${msg.content}`));
          break;

        case 'status_clear':
          log('🧹', FG.dim('Status cleared'));
          break;

        case 'message':
          result.botResponded = true;
          log('🤖', FG.green(`Bot response: ${msg.content?.slice(0, 200)}${msg.content?.length > 200 ? '...' : ''}`));
          // Got a response, test passed fully
          clearTimeout(timer);
          ws.close();
          resolve(result);
          break;

        case 'error':
          result.errors.push(msg.message);
          log('❌', FG.red(`Error: ${msg.message}`));
          break;

        default:
          log('📨', FG.dim(`Unknown message type: ${msg.type}`), msg);
      }
    });

    ws.on('error', (err: Error) => {
      result.errors.push(err.message);
      log('❌', FG.red(`WebSocket error: ${err.message}`));
      clearTimeout(timer);
      resolve(result);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      log('🔌', FG.dim(`Connection closed (code=${code}, reason=${reason.toString()})`));
      clearTimeout(timer);
      resolve(result);
    });
  });
}

// --- Main ---
(async () => {
  const result = await runTest();

  console.log();
  console.log(FG.cyan('─── Results ───'));
  const checks = [
    ['WebSocket Connect', result.connected],
    ['Auth Handshake', result.authenticated],
    ['Message Sent', result.messageSent],
    ['ACK Received', result.ackReceived],
    ['Bot Responded', result.botResponded],
  ] as const;

  for (const [label, passed] of checks) {
    const icon = passed ? FG.green('✓') : FG.red('✗');
    console.log(`  ${icon}  ${label}`);
  }

  if (result.errors.length) {
    console.log();
    console.log(FG.red('Errors:'));
    for (const e of result.errors) {
      console.log(`  • ${e}`);
    }
  }

  const essential = result.connected && result.authenticated && result.ackReceived;
  console.log();
  if (essential) {
    console.log(FG.green('✅ AppChannel connectivity test PASSED'));
  } else {
    console.log(FG.red('❌ AppChannel connectivity test FAILED'));
  }
  console.log();

  process.exit(essential ? 0 : 1);
})();
