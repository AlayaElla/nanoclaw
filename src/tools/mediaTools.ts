import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { WORKSPACE_DIR } from '../config.js';
import { describeImage, describeVideo } from '../vision.js';
import { transcribeAudioMessage } from '../transcription.js';

/**
 * Resolves the absolute path of a cached media file given its MediaID and the group folder.
 * Returns null if the file does not exist.
 */
export function getCachedMediaPath(
  agentName: string,
  mediaId: string,
): string | null {
  const safeId = path.basename(mediaId); // Prevent directory traversal
  const filePath = path.join(
    WORKSPACE_DIR,
    agentName,
    '.claude',
    'media_cache',
    safeId,
  );
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  return null;
}

/**
 * Saves a media buffer to the group's media cache and returns a unique MediaID.
 */
export function saveToMediaCache(
  agentName: string,
  buffer: Buffer,
  mediaType: 'photo' | 'video' | 'audio' | 'document' | 'image' | 'file',
): string {
  const typeMap: Record<string, string> = {
    photo: 'photo',
    image: 'photo',
    video: 'video',
    audio: 'audio',
    document: 'doc',
    file: 'doc',
  };
  const extMap: Record<string, string> = {
    photo: 'jpg',
    image: 'jpg',
    video: 'mp4',
    audio: 'ogg',
    document: 'bin',
    file: 'bin',
  };

  const prefix = typeMap[mediaType] || 'misc';
  const ext = extMap[mediaType] || 'bin';
  const mediaId = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;

  const cacheDir = path.join(
    WORKSPACE_DIR,
    agentName,
    '.claude',
    'media_cache',
  );

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, mediaId), buffer);

  return mediaId;
}

export async function describeCachedImage(
  agentName: string,
  mediaId: string,
  prompt: string,
): Promise<string> {
  const filePath = getCachedMediaPath(agentName, mediaId);
  if (!filePath) {
    return `Error: MediaID ${mediaId} not found in cache. It may have expired or the ID is incorrect.`;
  }

  try {
    const buffer = fs.readFileSync(filePath);
    const description = await describeImage(buffer, prompt);
    return description || 'Error: Vision API returned no description.';
  } catch (err: any) {
    return `Error reading or describing image: ${err.message}`;
  }
}

export async function describeCachedVideo(
  agentName: string,
  mediaId: string,
  prompt: string,
): Promise<string> {
  const filePath = getCachedMediaPath(agentName, mediaId);
  if (!filePath) {
    return `Error: MediaID ${mediaId} not found in cache.`;
  }

  try {
    const buffer = fs.readFileSync(filePath);
    const mimeMap: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
    };
    const ext = path.extname(filePath).toLowerCase();
    const mime = mimeMap[ext] || 'video/mp4';

    const description = await describeVideo(buffer, mime, prompt);
    return description || 'Error: Vision API returned no description.';
  } catch (err: any) {
    return `Error reading or describing video: ${err.message}`;
  }
}

export async function transcribeCachedAudio(
  agentName: string,
  mediaId: string,
): Promise<string> {
  const filePath = getCachedMediaPath(agentName, mediaId);
  if (!filePath) {
    return `Error: MediaID ${mediaId} not found in cache.`;
  }

  try {
    const buffer = fs.readFileSync(filePath);
    const transcript = await transcribeAudioMessage(buffer);
    return transcript || 'Error: Audio transcription failed to return text.';
  } catch (err: any) {
    return `Error reading or transcribing audio: ${err.message}`;
  }
}
