import "./instrument";
import express from "express";
import * as Sentry from "@sentry/node";
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
  "SENTRY_DSN",
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
 * Sentry error handler - MUST be before custom error handlers
 */
Sentry.setupExpressErrorHandler(app);

/**
 * Custom error handler - comes AFTER Sentry's handler
 */
app.use(errorHandler);

app.get("/debug-sentry", (req, res) => {
  console.log("Debug Sentry route hit");
  console.log("Sentry enabled:", !!process.env.SENTRY_DSN);
  console.log(
    "Sentry DSN starts with:",
    process.env.SENTRY_DSN?.substring(0, 20),
  );

  Sentry.captureMessage("Test message from debug-sentry route", "info");

  throw new Error(
    "Test Sentry error - if you see this in Sentry, it's working!",
  );
});

const port = config.PORT;

const server = app.listen(port, async () => {
  logger.info("Server started", {
    port,
    environment: config.NODE_ENV,
    nodeVersion: process.version,
    pid: process.pid,
    sentryEnabled: !!process.env.SENTRY_DSN,
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
      Sentry.captureException(error, {
        tags: {
          component: "webhook-initialization",
        },
      });
    }
  }

  // Log available endpoints for development convenience
  logger.info("API endpoints available", {
    health: `http://localhost:${port}${API_PREFIX}/health`,
    webhook: `http://localhost:${port}${API_PREFIX}/strava/webhook`,
    oauth: `http://localhost:${port}${API_PREFIX}/auth/strava`,
    admin: `http://localhost:${port}${API_PREFIX}/admin/*`,
    ...(config.isDevelopment && {
      debugSentry: `http://localhost:${port}/debug-sentry`,
    }),
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
 */
const gracefulShutdown = async (signal: NodeJS.Signals): Promise<void> => {
  logger.info("Shutdown signal received", { signal });

  await Sentry.close(2000);

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
  Sentry.captureException(reason, {
    tags: {
      type: "unhandledRejection",
    },
    extra: {
      promise: String(promise),
    },
  });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  Sentry.captureException(error, {
    tags: {
      type: "uncaughtException",
    },
  });
  gracefulShutdown("SIGTERM");
});
