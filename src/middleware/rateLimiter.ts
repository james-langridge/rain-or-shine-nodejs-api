import rateLimit from "express-rate-limit";
import { config } from "../config/environment";
import { logger } from "../utils/logger";

/**
 * Rate limiting middleware for Strava Weather API
 *
 * Provides three different rate limiters:
 * - Standard: General API endpoints (100 req/15min)
 * - Strict: Authentication endpoints (5 req/15min)
 * - Webhook: Strava webhook endpoint (1000 req/1min)
 */

/**
 * Enhanced rate limit handler with logging
 */
const rateLimitHandler = (limitType: string) => (req: any, res: any) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  const userAgent = req.get("User-Agent") || "Unknown";

  logger.warn("Rate limit exceeded", {
    limitType,
    ip: clientIp,
    userAgent,
    path: req.path,
    method: req.method,
    remainingPoints: res.getHeader("X-RateLimit-Remaining"),
    resetTime: res.getHeader("X-RateLimit-Reset"),
  });

  res.status(429).json({
    error: "Too Many Requests",
    message: "You have exceeded the rate limit. Please try again later.",
    retryAfter: res.getHeader("Retry-After"),
    type: limitType,
  });
};

/**
 * Standard rate limiter for general API endpoints
 * 100 requests per 15 minutes per IP
 */
export const standardRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: {
    error: "Too Many Requests",
    message: "Too many requests from this IP. Please try again later.",
    type: "standard",
  },
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
  handler: rateLimitHandler("standard"),
  skip: () => config.isDevelopment && !config.features.rateLimitingEnabled,
  keyGenerator: (req) => {
    // Use IP address as the key
    return req.ip || req.connection.remoteAddress || "unknown";
  },
});

/**
 * Strict rate limiter for authentication endpoints
 * 5 requests per 15 minutes per IP
 */
export const strictRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: {
    error: "Too Many Requests",
    message: "Too many authentication attempts. Please try again later.",
    type: "strict",
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler("strict"),
  skip: () => config.isDevelopment && !config.features.rateLimitingEnabled,
  keyGenerator: (req) => {
    return req.ip || req.connection.remoteAddress || "unknown";
  },
});

/**
 * Webhook rate limiter for Strava webhook endpoint
 * 1000 requests per minute (Strava can send bursts)
 */
export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000,
  message: {
    error: "Too Many Requests",
    message:
      "Webhook rate limit exceeded. Please contact support if this persists.",
    type: "webhook",
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler("webhook"),
  skip: () => config.isDevelopment && !config.features.rateLimitingEnabled,
  keyGenerator: (req) => {
    // For webhooks, we might want to use a combination of IP and user agent
    // since Strava webhooks come from specific IPs
    const ip = req.ip || req.connection.remoteAddress || "unknown";
    const userAgent = req.get("User-Agent") || "unknown";
    return `${ip}:${userAgent}`;
  },
});

/**
 * Health check endpoints should not be rate limited
 * This is a pass-through that logs access but doesn't limit
 */
export const healthCheckRateLimit = (req: any, res: any, next: any) => {
  // Log health check access for monitoring
  if (config.isDevelopment) {
    logger.debug("Health check accessed", {
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.get("User-Agent"),
      path: req.path,
    });
  }
  next();
};

/**
 * Rate limiter configuration summary for logging
 */
export const rateLimiterConfig = {
  standard: {
    windowMs: 15 * 60 * 1000,
    max: 100,
    description: "General API endpoints",
  },
  strict: {
    windowMs: 15 * 60 * 1000,
    max: 5,
    description: "Authentication endpoints",
  },
  webhook: {
    windowMs: 60 * 1000,
    max: 1000,
    description: "Strava webhook endpoint",
  },
  enabled: config.features.rateLimitingEnabled,
  environment: config.NODE_ENV,
};

// Log rate limiter configuration on startup
logger.info("Rate limiter configuration", rateLimiterConfig);
