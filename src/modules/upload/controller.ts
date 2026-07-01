import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { body } from 'express-validator';
import config from '../../config';
import validate from '../../middlewares/validationMiddleware';
import asyncHandler from '../../utils/asyncHandler';
import { createHttpError } from '../../utils/httpError';
import { createPresignedUpload, uploadBufferToS3 } from './service';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.s3.maxFileSizeBytes
  }
});

export const handleSingleFileUpload = (req: Request, res: Response, next: NextFunction) => {
  upload.single('file')(req, res, error => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(
          createHttpError(`File is too large. Max size is ${Math.round(config.s3.maxFileSizeBytes / (1024 * 1024))}MB`, 400, {
            code: 'UPLOAD_FILE_TOO_LARGE'
          })
        );
      }
    }

    return next(createHttpError(error.message || 'File upload failed', 400, { code: 'UPLOAD_FAILED' }));
  });
};

export const uploadFile = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) {
    throw createHttpError('Please attach a file using the "file" field', 400, { code: 'UPLOAD_FILE_REQUIRED' });
  }

  const uploadedFile = await uploadBufferToS3({
    buffer: req.file.buffer,
    mimeType: req.file.mimetype || 'application/octet-stream',
    originalName: req.file.originalname,
    folder: typeof req.body.folder === 'string' ? req.body.folder : undefined
  });

  res.status(201).json({
    message: 'File uploaded successfully',
    file: uploadedFile
  });
});

const presignedUploadValidators = [
  body('fileName').isString().trim().notEmpty(),
  body('contentType').isString().trim().notEmpty(),
  body('folder').optional().isString().trim().notEmpty()
];

export const createUploadUrl = [
  ...presignedUploadValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const uploadData = await createPresignedUpload({
      fileName: req.body.fileName,
      contentType: req.body.contentType,
      folder: req.body.folder
    });

    res.status(201).json({
      message: 'Presigned upload URL created',
      upload: uploadData
    });
  })
];
