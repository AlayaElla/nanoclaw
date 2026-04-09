const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:18790/ws/app?token=9e200addae7254c13cc55828556c7421');

ws.on('open', () => {
  console.log('Connected to gateway! Sending auth payload...');
  ws.send(JSON.stringify({
    type: 'auth',
    deviceId: 'test_pixel_001',
    token: '9e200addae7254c13cc55828556c7421',
    agentName: 'xingmeng-app'
  }));
});

ws.on('message', (data) => {
  console.log('Received message:', data.toString());
  
  const msg = JSON.parse(data);
  if (msg.type === 'auth_result' && msg.success) {
    setTimeout(() => {
      console.log('Auth successful! Sending a test message...');
      ws.send(JSON.stringify({
        type: 'message',
        content: 'Hello NanoClaw from Test App! Look! No trigger words needed now! Do you receive this?'
      }));
    }, 2000);
  }
});

ws.on('close', (code, reason) => {
  console.log('Connection closed:', code, reason.toString());
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err);
  process.exit(1);
});

// Timeout to exit automatically after 30s if we dont get a response
setTimeout(() => {
  console.log('Test complete, shutting down script.');
  ws.close();
}, 30000);
