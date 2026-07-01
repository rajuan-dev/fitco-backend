import crypto from 'crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../../config';
import { createHttpError } from '../../utils/httpError';

const s3Client = new S3Client({
  region: config.s3.region,
  credentials:
    config.s3.accessKeyId && config.s3.secretAccessKey
      ? {
          accessKeyId: config.s3.accessKeyId,
          secretAccessKey: config.s3.secretAccessKey
        }
      : undefined
});

const ensureS3Configured = () => {
  if (!config.s3.region || !config.s3.bucket || !config.s3.accessKeyId || !config.s3.secretAccessKey) {
    throw createHttpError('AWS S3 is not configured', 500, { code: 'S3_NOT_CONFIGURED' });
  }
};

const sanitizeFileName = (fileName: string) =>
  fileName
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLowerCase();

const buildObjectKey = (fileName: string, folder?: string) => {
  const safeFileName = sanitizeFileName(fileName || 'file');
  const normalizedFolder = (folder || config.s3.defaultFolder).replace(/^\/+|\/+$/g, '');
  const uniquePrefix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

  return normalizedFolder ? `${normalizedFolder}/${uniquePrefix}-${safeFileName}` : `${uniquePrefix}-${safeFileName}`;
};

const buildFileUrl = (key: string) =>
  `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${encodeURI(key).replace(/#/g, '%23')}`;

const validateMimeType = (mimeType: string) => {
  if (config.s3.allowedMimeTypes.length === 0) {
    return;
  }

  if (!config.s3.allowedMimeTypes.includes(mimeType)) {
    throw createHttpError('File type is not allowed', 400, {
      code: 'UPLOAD_INVALID_FILE_TYPE',
      details: { allowedMimeTypes: config.s3.allowedMimeTypes }
    });
  }
};

export interface UploadBufferInput {
  buffer: Buffer;
  mimeType: string;
  originalName: string;
  folder?: string;
}

export interface UploadResult {
  key: string;
  bucket: string;
  region: string;
  url: string;
  contentType: string;
  originalName: string;
  size: number;
}

export const uploadBufferToS3 = async (input: UploadBufferInput): Promise<UploadResult> => {
  ensureS3Configured();
  validateMimeType(input.mimeType);

  const key = buildObjectKey(input.originalName, input.folder);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: input.buffer,
      ContentType: input.mimeType
    })
  );

  return {
    key,
    bucket: config.s3.bucket,
    region: config.s3.region,
    url: buildFileUrl(key),
    contentType: input.mimeType,
    originalName: input.originalName,
    size: input.buffer.length
  };
};

export interface PresignedUploadInput {
  fileName: string;
  contentType: string;
  folder?: string;
}

export const createPresignedUpload = async (input: PresignedUploadInput) => {
  ensureS3Configured();
  validateMimeType(input.contentType);

  const key = buildObjectKey(input.fileName, input.folder);
  const command = new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    ContentType: input.contentType
  });

  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: config.s3.signedUrlExpiresSeconds
  });

  return {
    key,
    bucket: config.s3.bucket,
    region: config.s3.region,
    uploadUrl,
    expiresIn: config.s3.signedUrlExpiresSeconds,
    fileUrl: buildFileUrl(key)
  };
};
