import { initRag, getEmbedding } from './rag.js';
import { logger } from './logger.js';

async function verify() {
  process.env.DEBUG = 'nanoclaw:*';
  initRag();

  try {
    console.log('Testing text embedding...');
    const textVector = await getEmbedding(
      'Hello from NanoClaw multimodal RAG!',
    );
    console.log('Text vector length:', textVector.length);
    if (textVector.length === 2560) {
      console.log('✅ Text embedding successful (2560 dim)');
    } else {
      console.error(
        '❌ Text embedding failed: expected 2560 dimensions, got',
        textVector.length,
      );
    }

    console.log('\nTesting image embedding (fusion)...');
    // Using a sample image URL from Aliyun docs
    const fusionVector = await getEmbedding({
      text: 'A beautiful sunset',
      image: 'https://dashscope.oss-cn-beijing.aliyuncs.com/images/256_1.png',
    });
    console.log('Fusion vector length:', fusionVector.length);
    if (fusionVector.length === 2560) {
      console.log('✅ Fusion embedding successful (2560 dim)');
    } else {
      console.error('❌ Fusion embedding failed');
    }
  } catch (err) {
    console.error('Verification failed:', err);
  }
}

verify();
