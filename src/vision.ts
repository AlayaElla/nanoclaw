import { readEnvFile } from './env.js';

interface VisionConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

function loadConfig(): VisionConfig {
  const env = readEnvFile(['VISION_API_KEY', 'VISION_BASE_URL', 'VISION_MODEL']);
  const apiKey = env.VISION_API_KEY || '';

  return {
    model: env.VISION_MODEL || 'qwen3.5-plus',
    baseUrl: env.VISION_BASE_URL || 'https://coding.dashscope.aliyuncs.com/v1',
    apiKey,
    enabled: !!apiKey,
  };
}

/**
 * Shared helper: call the vision model API with arbitrary user content.
 */
async function callVisionApi(
  userContent: Array<Record<string, unknown>>,
  config: VisionConfig,
): Promise<string | null> {
  if (!config.apiKey) {
    console.warn('VISION_API_KEY not set in .env');
    return null;
  }

  try {
    const response = await fetch(
      `${config.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: 'user',
              content: userContent,
            },
          ],
          stream: false,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Vision API error (${response.status}): ${errorText}`);
      return null;
    }

    const result = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ text?: string }>;
        };
      }>;
    };

    const choice = result.choices?.[0];
    if (!choice?.message?.content) {
      console.error('Vision API returned empty content');
      return null;
    }

    const content = choice.message.content;
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => item.text || '')
        .join('')
        .trim();
    }

    return null;
  } catch (err) {
    console.error('Vision API call failed:', err);
    return null;
  }
}

/**
 * Describe an image buffer using a vision model (DashScope Qwen-VL compatible).
 * This function is channel-agnostic — the caller is responsible for
 * downloading the image and passing the raw buffer.
 */
export async function describeImage(
  imageBuffer: Buffer,
  caption?: string,
): Promise<string | null> {
  const config = loadConfig();

  if (!config.enabled) {
    return '[Photo - description unavailable]';
  }

  if (!imageBuffer || imageBuffer.length === 0) {
    console.error('Empty image buffer provided for description');
    return '[Photo - description unavailable]';
  }

  console.log(`Describing image: ${imageBuffer.length} bytes`);

  try {
    const base64Image = imageBuffer.toString('base64');
    const dataUri = `data:image/jpeg;base64,${base64Image}`;

    const userContent: Array<Record<string, unknown>> = [
      { type: 'image_url', image_url: { url: dataUri } },
      {
        type: 'text',
        text: caption
          ? `用户发送了这张图片并说："${caption}"。请根据图片内容回答用户的问题或回应用户的说明。如果用户没有明确提问，请简洁描述图片内容并结合用户的说明。`
          : '请用简洁的语言描述这张图片的内容。',
      },
    ];

    const description = await callVisionApi(userContent, config);
    return description?.trim() || '[Photo - description unavailable]';
  } catch (err) {
    console.error('Image description error:', err);
    return '[Photo - description unavailable]';
  }
}

/**
 * Describe a video buffer using a vision model (DashScope Qwen-VL compatible).
 * Uses the video_url content type with base64 data URI.
 * This function is channel-agnostic — the caller is responsible for
 * downloading the video and passing the raw buffer.
 */
export async function describeVideo(
  videoBuffer: Buffer,
  mimeType?: string,
  caption?: string,
): Promise<string | null> {
  const config = loadConfig();

  if (!config.enabled) {
    return '[Video - description unavailable]';
  }

  if (!videoBuffer || videoBuffer.length === 0) {
    console.error('Empty video buffer provided for description');
    return '[Video - description unavailable]';
  }

  console.log(`Describing video: ${videoBuffer.length} bytes`);

  try {
    const base64Video = videoBuffer.toString('base64');
    const mime = mimeType || 'video/mp4';
    const dataUri = `data:${mime};base64,${base64Video}`;

    const userContent: Array<Record<string, unknown>> = [
      { type: 'video_url', video_url: { url: dataUri }, fps: 2 },
      {
        type: 'text',
        text: caption
          ? `用户发送了这段视频并说："${caption}"。请根据视频内容回答用户的问题或回应用户的说明。如果用户没有明确提问，请简洁描述视频内容并结合用户的说明。`
          : '请用简洁的语言描述这段视频的内容。',
      },
    ];

    const description = await callVisionApi(userContent, config);
    return description?.trim() || '[Video - description unavailable]';
  } catch (err) {
    console.error('Video description error:', err);
    return '[Video - description unavailable]';
  }
}

