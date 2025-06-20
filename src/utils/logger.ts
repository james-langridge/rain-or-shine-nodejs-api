import winston from "winston";
import { config } from "../config/environment";

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define colors for each level
const colors = {
  error: "red",
  warn: "yellow",
  info: "green",
  http: "magenta",
  debug: "blue",
};

// Tell winston about our colors
winston.addColors(colors);

// Define format for development
const devFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaString = Object.keys(meta).length
      ? JSON.stringify(meta, null, 2)
      : "";
    return `${timestamp} [${level}] ${message} ${metaString}`;
  }),
);

// Define format for production
const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// Create the logger
export const logger = winston.createLogger({
  level: config.isDevelopment ? "debug" : "info",
  levels,
  format: config.isDevelopment ? devFormat : prodFormat,
  transports: [new winston.transports.Console()],
  // Don't exit on handled exceptions
  exitOnError: false,
});

// Create a stream object for Morgan HTTP logger
export const stream = {
  write: (message: string) => {
    // Remove trailing newline
    logger.http(message.trim());
  },
};

// Convenience methods for structured logging
export const logError = (
  message: string,
  error: unknown,
  meta?: Record<string, any>,
) => {
  const errorMeta =
    error instanceof Error
      ? {
          errorMessage: error.message,
          errorStack: error.stack,
          ...meta,
        }
      : { error, ...meta };

  logger.error(message, errorMeta);
};

export const logInfo = (message: string, meta?: Record<string, any>) => {
  logger.info(message, meta || {});
};

export const logWarn = (message: string, meta?: Record<string, any>) => {
  logger.warn(message, meta || {});
};

export const logDebug = (message: string, meta?: Record<string, any>) => {
  logger.debug(message, meta || {});
};

// Child logger factory for specific services
export const createServiceLogger = (service: string) => {
  return logger.child({ service });
};
