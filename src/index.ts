import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config/environment";
import { errorHandler } from "./middleware/errorHandler";
import { requestLogger } from "./middleware/requestLogger";
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
  "JWT_SECRET",
  "ENCRYPTION_KEY",
];

requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    logger.error(`Missing required environment variable: ${varName}`);
    process.exit(1);
  }
});

/**
 * Express application factory
 * Creates and configures the Express application with all middleware and routes
 */
const app = express();

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
 * Order is important: parsing → logging → routes → error handling
 */
app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());
app.use(requestLogger);

/**
 * API route configuration
 * All routes are prefixed with /api for clear separation from static assets
 */
const API_PREFIX = "/api";
app.use(`${API_PREFIX}/health`, healthRouter);
app.use(`${API_PREFIX}/strava`, stravaRouter);
app.use(`${API_PREFIX}/auth`, authRouter);
app.use(`${API_PREFIX}/users`, usersRouter);
app.use(`${API_PREFIX}/activities`, activitiesRouter);
app.use(`${API_PREFIX}/admin`, adminRouter);

/**
 * Global error handler
 * Must be registered last to catch all errors
 */
app.use(errorHandler);

const port = config.PORT;

const server = app.listen(port, async () => {
  logger.info("Server started", {
    port,
    environment: config.NODE_ENV,
    nodeVersion: process.version,
    pid: process.pid,
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

  // Log available endpoints for development convenience
  logger.info("API endpoints available", {
    health: `http://localhost:${port}${API_PREFIX}/health`,
    webhook: `http://localhost:${port}${API_PREFIX}/strava/webhook`,
    oauth: `http://localhost:${port}${API_PREFIX}/auth/strava`,
    admin: `http://localhost:${port}${API_PREFIX}/admin/*`,
  });

  if (config.isDevelopment) {
    logger.info("Development mode active", {
      frontendUrl: config.APP_URL,
      apiProxy: `${config.APP_URL}/api/* → http://localhost:${port}/api/*`,
    });
  }
});

/**
 * Graceful shutdown handler
 * Ensures connections are closed properly and resources are cleaned up
 */
const gracefulShutdown = async (signal: NodeJS.Signals): Promise<void> => {
  logger.info("Shutdown signal received", { signal });

  // Stop accepting new connections
  server.close(async (err) => {
    if (err) {
      logger.error("Error during server shutdown", err);
      process.exit(1);
    }

    logger.info("HTTP server closed");

    try {
      // Perform cleanup tasks
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
  }, 10000); // 10 second timeout
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

export default app;
