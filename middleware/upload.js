import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ValidationError } from '../utils/errors.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'public/uploads';
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 2);

const ALLOWED_MIME = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['application/pdf', '.pdf'],
]);

const ALLOWED_EXT = new Set([...ALLOWED_MIME.values()]);

fs.mkdirSync(path.resolve(UPLOAD_DIR), { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.resolve(UPLOAD_DIR)),
  filename: (_req, file, cb) => {
    const ext = ALLOWED_MIME.get(file.mimetype) || path.extname(file.originalname).toLowerCase();
    const safeExt = ALLOWED_EXT.has(ext) ? ext : '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new ValidationError('Unsupported file type. Upload a PNG, JPG, WEBP, GIF or PDF.'));
  }
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext && !ALLOWED_EXT.has(ext)) {
    return cb(new ValidationError('File extension does not match an allowed type.'));
  }
  return cb(null, true);
};

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 5 },
});

export const uploadSingle = upload.single('file');
export const uploadAvatar = upload.single('avatar');
export const uploadMultiple = upload.array('files', 5);

/** Public URL for a stored file (served from /uploads). */
export const publicUrlFor = (file) => (file ? `/uploads/${path.basename(file.path)}` : '');

export default { upload, uploadSingle, uploadAvatar, uploadMultiple, publicUrlFor };
