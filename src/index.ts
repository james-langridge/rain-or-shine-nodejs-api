import "./instrument";
import express from "express";
import * as Sentry from "@sentry/node";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import passport from "./config/passport";
import { sessionConfig } from "./config/session";
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
import { sentryRouter } from "./routes/sentry";

const requiredEnvVars = [
  "DATABASE_URL",
  "STRAVA_CLIENT_ID",
  "STRAVA_CLIENT_SECRET",
  "SESSION_SECRET",
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

app.use("/api/sentry", sentryRouter);

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
 * API route configuration
 */
const API_PREFIX = "/api";
app.use(`${API_PREFIX}/health`, healthRouter);
app.use(`${API_PREFIX}/strava`, stravaRouter);
app.use(`${API_PREFIX}/auth`, authRouter);
app.use(`${API_PREFIX}/users`, usersRouter);
app.use(`${API_PREFIX}/activities`, activitiesRouter);
app.use(`${API_PREFIX}/admin`, adminRouter);

/**
 * Sentry error handler
 */
Sentry.setupExpressErrorHandler(app);

/**
 * Custom error handler
 */
app.use(errorHandler);

app.get("/debug-sentry", (req, res) => {
  console.log("Debug Sentry route hit");
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
      Sentry.captureException(error, {
        tags: {
          component: "webhook-initialization",
        },
      });
    }
  }

  logger.info("API endpoints available", {
    health: `http://localhost:${port}${API_PREFIX}/health`,
    webhook: `http://localhost:${port}${API_PREFIX}/strava/webhook`,
    oauth: `http://localhost:${port}${API_PREFIX}/auth/strava`,
    admin: `http://localhost:${port}${API_PREFIX}/admin/*`,
    ...(config.isDevelopment && {
      debugSentry: `http://localhost:${port}/debug-sentry`,
    }),
  });
});

/**
 * Graceful shutdown handler
 */
const gracefulShutdown = async (signal: NodeJS.Signals): Promise<void> => {
  logger.info("Shutdown signal received", { signal });

  await Sentry.close(2000);

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
  Sentry.captureException(reason);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  Sentry.captureException(error);
  gracefulShutdown("SIGTERM");
});
