import multer from 'multer';

const storage = multer.memoryStorage();
const limits = { fileSize: 5 * 1024 * 1024 };

export const refundUploadMiddleware = multer({ storage, limits: { ...limits, files: 5 } }).array(
  'files',
  5
);

export const refundSingleUploadMiddleware = multer({ storage, limits: { ...limits, files: 1 } }).single(
  'file'
);
