import multer from 'multer';

export const refundUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
}).array('files', 5);
