import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import passport from "./config/passport";
import { sessionConfig } from "./config/session";
import { config } from "./config/environment";
import { errorHandler } from "./middleware/errorHandler";
import { requestLogger } from "./middleware/requestLogger";
import {
  standardRateLimit,
  strictRateLimit,
  webhookRateLimit,
  healthCheckRateLimit,
} from "./middleware/rateLimiter";
import { logger } from "./utils/logger";

// Route imports
import { healthRouter } from "./routes/health";
import { stravaRouter } from "./routes/strava";
import { authRouter } from "./routes/auth";
import { usersRouter } from "./routes/users";
import { activitiesRouter } from "./routes/activities";
import { adminRouter } from "./routes/admin";

const requiredEnvVars = [
  "DATABASE_URL",
  "STRAVA_CLIENT_ID",
  "STRAVA_CLIENT_SECRET",
  "SESSION_SECRET",
];

requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    logger.error(`Missing required environment variable: ${varName}`);
    process.exit(1);
  }
});

/**
 * Express application factory
 */
const app = express();

// Trust proxy configuration for Coolify/Traefik
app.set("trust proxy", true);

/**
 * CORS configuration
 */
const corsOptions: cors.CorsOptions = {
  origin: config.isProduction
    ? [
        "https://ngridge.com",
        "https://www.ngridge.com",
        "https://strava-weather.ngridge.com",
        "http://localhost:5173",
      ]
    : true, // Allow all in development
  credentials: true,
  maxAge: 86400, // 24 hours
};

/**
 * Global middleware stack
 * Order is important: parsing → session → passport → logging → routes → error handling
 */
app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());
app.use(session(sessionConfig));
app.use(passport.initialize());
app.use(passport.session());

app.use(requestLogger);

/**
 * Rate limiting configuration
 * Applied before routes but after authentication middleware
 */
const API_PREFIX = "/api";

// Health endpoints - no rate limiting but with logging
app.use(`${API_PREFIX}/health`, healthCheckRateLimit, healthRouter);

// Webhook endpoint - high rate limit for Strava bursts
app.use(`${API_PREFIX}/strava/webhook`, webhookRateLimit);

// Auth endpoints - strict rate limiting
app.use(`${API_PREFIX}/auth`, strictRateLimit, authRouter);

// All other API endpoints - standard rate limiting
app.use(`${API_PREFIX}/strava`, standardRateLimit, stravaRouter);
app.use(`${API_PREFIX}/users`, standardRateLimit, usersRouter);
app.use(`${API_PREFIX}/activities`, standardRateLimit, activitiesRouter);
app.use(`${API_PREFIX}/admin`, standardRateLimit, adminRouter);

/**
 * Custom error handler
 */
app.use(errorHandler);

const port = config.PORT;

const server = app.listen(port, async () => {
  logger.info("Server started", {
    port,
    environment: config.NODE_ENV,
    nodeVersion: process.version,
    pid: process.pid,
    authMethod: "session",
  });

  // Initialize webhooks in production
  if (config.isProduction) {
    try {
      const { ensureWebhooksInitialized } = await import(
        "./utils/initWebhooks"
      );
      await ensureWebhooksInitialized();
    } catch (error) {
      logger.error("Failed to initialize webhooks", error);
    }
  }

  logger.info("API endpoints available", {
    health: `http://localhost:${port}${API_PREFIX}/health`,
    webhook: `http://localhost:${port}${API_PREFIX}/strava/webhook`,
    oauth: `http://localhost:${port}${API_PREFIX}/auth/strava`,
    admin: `http://localhost:${port}${API_PREFIX}/admin/*`,
  });
});

/**
 * Graceful shutdown handler
 */
const gracefulShutdown = async (signal: NodeJS.Signals): Promise<void> => {
  logger.info("Shutdown signal received", { signal });

  server.close(async (err) => {
    if (err) {
      logger.error("Error during server shutdown", err);
      process.exit(1);
    }

    logger.info("HTTP server closed");

    try {
      // Cleanup tasks
      if (config.isDevelopment) {
        const { cleanupWebhookOnShutdown } = await import(
          "./services/startupWebhookSetup"
        );
        await cleanupWebhookOnShutdown();
      }

      // Close database connections
      const { prisma } = await import("./lib");
      await prisma.$disconnect();
      logger.info("Database connections closed");

      logger.info("Graceful shutdown completed");
      process.exit(0);
    } catch (error) {
      logger.error("Error during cleanup", error);
      process.exit(1);
    }
  });

  // Force shutdown after timeout
  setTimeout(() => {
    logger.error("Forced shutdown due to timeout");
    process.exit(1);
  }, 10000);
};

// Register shutdown handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught errors
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled promise rejection", { reason, promise });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  gracefulShutdown("SIGTERM");
});
