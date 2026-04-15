import OSS from 'ali-oss';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { STORE_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

let ossDb: Database.Database | null = null;
let ossClient: OSS | null = null;

export function initOSS(): void {
  const envVars = readEnvFile([
    'OSS_REGION',
    'OSS_ACCESS_KEY_ID',
    'OSS_ACCESS_KEY_SECRET',
    'OSS_BUCKET'
  ]);
  
  const region = process.env.OSS_REGION || envVars.OSS_REGION;
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID || envVars.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET || envVars.OSS_ACCESS_KEY_SECRET;
  const bucket = process.env.OSS_BUCKET || envVars.OSS_BUCKET;

  if (region && accessKeyId && accessKeySecret && bucket) {
    ossClient = new OSS({
      region,
      accessKeyId,
      accessKeySecret,
      bucket
    });

    try {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      const dbPath = path.join(STORE_DIR, 'oss.db');
      ossDb = new Database(dbPath);
      ossDb.exec(`
        CREATE TABLE IF NOT EXISTS oss_cache (
          media_id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          uploaded_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_uploaded_at ON oss_cache(uploaded_at);
      `);
      logger.info('OSS service and cache database initialized');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize OSS database');
    }
  } else {
    logger.info('OSS credentials not fully configured. OSS service is disabled.');
  }
}

export function isOSSEnabled(): boolean {
  return ossClient !== null && ossDb !== null;
}

export async function uploadMediaIfNeeded(
  mediaId: string,
  fileData: string | Buffer,
  typeStr: 'Photo' | 'Video' | 'Audio' | 'Document' | string
): Promise<string | null> {
  if (!isOSSEnabled()) return null;

  try {
    const row = ossDb!.prepare('SELECT url, uploaded_at FROM oss_cache WHERE media_id = ?').get(mediaId) as { url: string; uploaded_at: number } | undefined;
    
    if (row) {
      const ageDays = (Date.now() - row.uploaded_at) / (1000 * 60 * 60 * 24);
      if (ageDays < 6.5) {
        logger.debug({ mediaId }, 'OSS cache hit');
        return row.url;
      }
      logger.debug({ mediaId, ageDays }, 'OSS cache expired, re-uploading');
    }

    const uniqueName = crypto.randomUUID().replace(/-/g, '');
    let ext = '';
    if (typeof fileData === 'string') {
        ext = path.extname(fileData);
    }
    if (!ext) {
        if (typeStr === 'Photo') ext = '.jpg';
        else if (typeStr === 'Video') ext = '.mp4';
        else if (typeStr === 'Audio') ext = '.ogg';
    }
    
    // Convert to HTTP protocol instead of OSS-internal endpoints generally used by the SDK
    // Also use the media_cache prefix
    const objectName = `media_cache/${uniqueName}${ext}`;
    
    logger.info({ mediaId, objectName }, 'Uploading to OSS...');
    const result = await ossClient!.put(objectName, fileData);
    
    if (result) {
      // 必须生成一个带鉴权的预签名外链（设定期效 6.5 天，对应本地失效拦截时间）。
      // 这样即便用户的 Bucket 配置为【纯私有（Private）】，大模型拿到链接后依然能畅通下载。
      // 而且自带 HTTP 转 HTTPS 和鉴权尾巴。
      const signedUrl = ossClient!.signatureUrl(objectName, {
        expires: 3600 * 24 * 6.5,
        method: 'GET'
      });

      let finalUrl = signedUrl;
      if (finalUrl.startsWith('http://')) {
          finalUrl = finalUrl.replace('http://', 'https://');
      }

      ossDb!.prepare('INSERT OR REPLACE INTO oss_cache (media_id, url, uploaded_at) VALUES (?, ?, ?)').run(mediaId, finalUrl, Date.now());
      logger.info({ mediaId }, 'OSS object uploaded successfully and signed URL generated');
      return finalUrl;
    }
    return null;
  } catch (err) {
    logger.error({ err, mediaId }, 'OSS upload failed');
    return null;
  }
}
