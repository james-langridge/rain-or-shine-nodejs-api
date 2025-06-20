import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { config } from "../config/environment";
import { logger } from "../utils/logger";

/**
 * Custom application error class
 *
 * Provides a standardized error structure with additional metadata
 * for consistent error handling across the application.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly timestamp: string;

  constructor(
    message: string,
    statusCode: number = 500,
    isOperational: boolean = true,
  ) {
    super(message);

    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();

    // Maintain proper stack trace for debugging
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error code mappings for common HTTP scenarios
 */
const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

/**
 * Transform Zod validation errors into AppError
 */
function handleZodError(error: ZodError): AppError {
  const messages = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "request";
    return `${path}: ${issue.message}`;
  });

  return new AppError(
    `Validation failed: ${messages.join("; ")}`,
    ERROR_CODES.VALIDATION_ERROR,
  );
}

/**
 * Transform Prisma database errors into AppError
 *
 * @see https://www.prisma.io/docs/reference/api-reference/error-reference
 */
function handlePrismaError(error: any): AppError {
  const errorMap: Record<string, { message: string; status: number }> = {
    P2002: {
      message:
        "A unique constraint violation occurred. This record already exists.",
      status: ERROR_CODES.CONFLICT,
    },
    P2025: {
      message: "The requested record was not found.",
      status: ERROR_CODES.NOT_FOUND,
    },
    P2003: {
      message: "Foreign key constraint failed. Related record does not exist.",
      status: ERROR_CODES.VALIDATION_ERROR,
    },
    P2014: {
      message: "The provided data violates a database constraint.",
      status: ERROR_CODES.VALIDATION_ERROR,
    },
    P2024: {
      message: "Connection to the database timed out.",
      status: ERROR_CODES.SERVICE_UNAVAILABLE,
    },
  };

  const errorInfo = errorMap[error.code];

  if (errorInfo) {
    return new AppError(errorInfo.message, errorInfo.status);
  }

  // Log unknown Prisma errors for investigation
  logger.warn("Unknown Prisma error code", {
    code: error.code,
    message: error.message,
  });
  return new AppError("Database operation failed.", ERROR_CODES.INTERNAL_ERROR);
}

/**
 * Transform external API errors into AppError
 */
function handleExternalApiError(error: any, serviceName: string): AppError {
  const status = error.response?.status;

  if (status === 401) {
    return new AppError(
      `Authentication with ${serviceName} failed. Please reconnect your account.`,
      ERROR_CODES.UNAUTHORIZED,
    );
  }

  if (status === 403) {
    return new AppError(
      `Insufficient permissions for ${serviceName} operation.`,
      ERROR_CODES.FORBIDDEN,
    );
  }

  if (status === 429) {
    const retryAfter = error.response?.headers?.["retry-after"];
    const message = retryAfter
      ? `${serviceName} rate limit exceeded. Retry after ${retryAfter} seconds.`
      : `${serviceName} rate limit exceeded. Please try again later.`;
    return new AppError(message, ERROR_CODES.RATE_LIMITED);
  }

  if (status >= 400 && status < 500) {
    return new AppError(
      `Invalid request to ${serviceName}.`,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  if (status >= 500) {
    return new AppError(
      `${serviceName} is experiencing issues. Please try again later.`,
      ERROR_CODES.SERVICE_UNAVAILABLE,
    );
  }

  return new AppError(
    `Failed to communicate with ${serviceName}.`,
    ERROR_CODES.SERVICE_UNAVAILABLE,
  );
}

/**
 * Central error handling middleware
 *
 * Transforms various error types into standardized responses
 * and ensures consistent error logging and client responses.
 */
export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let appError: AppError;

  // Transform error to AppError based on type
  if (error instanceof AppError) {
    appError = error;
  } else if (error instanceof ZodError) {
    appError = handleZodError(error);
  } else if (error.name === "PrismaClientKnownRequestError") {
    appError = handlePrismaError(error);
  } else if (error.message?.toLowerCase().includes("strava")) {
    appError = handleExternalApiError(error, "Strava");
  } else if (error.message?.toLowerCase().includes("openweathermap")) {
    appError = handleExternalApiError(error, "OpenWeatherMap");
  } else {
    // Generic errors
    appError = new AppError(
      config.isProduction ? "An unexpected error occurred." : error.message,
      ERROR_CODES.INTERNAL_ERROR,
      false,
    );
  }

  // Log error with appropriate level
  const logLevel = appError.statusCode >= 500 ? "error" : "warn";
  const logData = {
    timestamp: appError.timestamp,
    method: req.method,
    url: req.url,
    statusCode: appError.statusCode,
    message: appError.message,
    isOperational: appError.isOperational,
    userId: (req as any).user?.id,
    requestId: (req as any).requestId,
    ...(config.isDevelopment && { stack: appError.stack }),
  };

  logger[logLevel]("Request error", logData);

  // Send error response
  const errorResponse = {
    error: {
      message: appError.message,
      statusCode: appError.statusCode,
      timestamp: appError.timestamp,
      requestId: (req as any).requestId,
      ...(config.isDevelopment && {
        stack: appError.stack,
        originalError: error.message,
      }),
    },
  };

  res.status(appError.statusCode).json(errorResponse);
}

/**
 * Global error handlers
 *
 * These handlers catch errors that escape the Express error handling
 * middleware and prevent the application from crashing unexpectedly.
 */

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason: unknown, promise: Promise<any>) => {
  logger.error("Unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: String(promise),
  });

  // In production, exit gracefully to trigger container restart
  if (config.isProduction) {
    logger.error("Initiating graceful shutdown due to unhandled rejection");
    process.exit(1);
  }
});

// Handle uncaught exceptions
process.on("uncaughtException", (error: Error) => {
  logger.error("Uncaught exception", {
    message: error.message,
    stack: error.stack,
    name: error.name,
  });

  // Always exit on uncaught exceptions as the process is in an undefined state
  logger.error("Initiating immediate shutdown due to uncaught exception");
  process.exit(1);
});

/**
 * Async route handler wrapper
 *
 * Wraps async route handlers to automatically catch rejected promises
 * and forward them to the error handling middleware.
 *
 * @example
 * router.get('/users/:id', asyncHandler(async (req, res) => {
 *   const user = await getUserById(req.params.id);
 *   res.json(user);
 * }));
 */
export function asyncHandler<T extends Request, U extends Response>(
  fn: (req: T, res: U, next: NextFunction) => Promise<any>,
) {
  return (req: T, res: U, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 Not Found handler
 *
 * Catches requests to undefined routes and returns a standardized error.
 * Should be registered after all other routes.
 */
export function notFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const error = new AppError(
    `The requested resource ${req.originalUrl} was not found.`,
    ERROR_CODES.NOT_FOUND,
  );
  next(error);
}
