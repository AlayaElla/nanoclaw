import { readEnvFile } from './env.js';

interface TranscriptionConfig {
  model: string;
  enabled: boolean;
  fallbackMessage: string;
}

const DEFAULT_CONFIG: TranscriptionConfig = {
  model: 'qwen3-asr-flash',
  enabled: true,
  fallbackMessage: '[Voice Message - transcription unavailable]',
};

async function transcribeWithDashScope(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  const env = readEnvFile(['EMBEDDING_API_KEY']);
  const apiKey = env.EMBEDDING_API_KEY;

  if (!apiKey) {
    console.warn('EMBEDDING_API_KEY not set in .env');
    return null;
  }

  try {
    // Convert audio buffer to base64 data URI
    const base64Audio = audioBuffer.toString('base64');
    const audioDataUri = `data:audio/ogg;base64,${base64Audio}`;

    const response = await fetch(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: 'system',
              content: [{ text: '' }],
            },
            {
              role: 'user',
              content: [{ audio: audioDataUri }],
            },
          ],
          stream: false,
          asr_options: {
            enable_lid: true,
            enable_itn: false,
          },
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`DashScope API error (${response.status}): ${errorText}`);
      return null;
    }

    const result = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ text?: string }>;
        };
      }>;
    };

    // Extract transcription text from response
    const choice = result.choices?.[0];
    if (!choice?.message?.content) {
      console.error('DashScope returned empty transcription');
      return null;
    }

    const content = choice.message.content;
    if (typeof content === 'string') {
      return content;
    }

    // content may be an array of objects with text field
    if (Array.isArray(content)) {
      return content
        .map((item) => item.text || '')
        .join('')
        .trim();
    }

    return null;
  } catch (err) {
    console.error('DashScope transcription failed:', err);
    return null;
  }
}

/**
 * Transcribe an audio buffer to text using Qwen3 ASR (DashScope).
 * This function is channel-agnostic — the caller is responsible for
 * downloading the audio and passing the raw buffer.
 */
export async function transcribeAudioMessage(
  audioBuffer: Buffer,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    console.error('Empty audio buffer provided for transcription');
    return config.fallbackMessage;
  }

  console.log(`Transcribing audio: ${audioBuffer.length} bytes`);

  try {
    const transcript = await transcribeWithDashScope(audioBuffer, config);

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return config.fallbackMessage;
  }
}
