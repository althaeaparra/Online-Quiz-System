import winston from 'winston';
import fs from 'node:fs';
import path from 'node:path';

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

const LOG_DIR = process.env.LOG_DIR || 'logs';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const isTest = process.env.NODE_ENV === 'test';

/** Colourised, single-line console format for humans. */
const consoleFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${ts} ${level} ${stack || message}${extra}`;
  }),
);

const transports = [
  new winston.transports.Console({
    format: consoleFormat,
    silent: isTest,
  }),
];

// File transport (skip in tests / read-only environments).
try {
  if (!isTest) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    transports.push(
      new winston.transports.File({
        filename: path.join(LOG_DIR, 'error.log'),
        level: 'error',
        maxsize: 5 * 1024 * 1024,
        maxFiles: 5,
        format: combine(timestamp(), errors({ stack: true }), json()),
      }),
      new winston.transports.File({
        filename: path.join(LOG_DIR, 'combined.log'),
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
        format: combine(timestamp(), errors({ stack: true }), json()),
      }),
    );
  }
} catch {
  // A read-only filesystem should never stop the API from booting.
}

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  defaultMeta: { service: 'citebraincheck-api' },
  transports,
  exitOnError: false,
});

/** Morgan stream adapter so HTTP access logs go through Winston. */
export const httpLogStream = {
  write: (message) => logger.http(message.trim()),
};

export default logger;
