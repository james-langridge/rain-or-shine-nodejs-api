import { config as dotenvConfig } from "dotenv";
import { z } from "zod";
import path from "path";

/**
 * Environment configuration module
 *
 * Handles environment variable loading, validation, and type-safe access
 * throughout the application. Uses Zod for runtime validation to ensure
 * all required configuration is present at startup.
 */

// Resolve .env file path based on current working directory
const envPath = path.resolve(
  process.cwd(),
  process.cwd().endsWith("/server") ? "../.env" : ".env",
);

// Load environment variables from .env file
dotenvConfig({ path: envPath });

/**
 * Environment variable validation schema
 * Defines all required and optional environment variables with their types
 */
const environmentSchema = z.object({
  // Application environment
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.string().transform(Number).default("3001"),
  APP_URL: z.string().url(),

  // Database configuration
  DATABASE_URL: z.string().url(),

  // Admin authentication
  ADMIN_TOKEN: z.string().optional(),

  // Strava API credentials
  STRAVA_CLIENT_ID: z.string().min(1),
  STRAVA_CLIENT_SECRET: z.string().min(1),
  STRAVA_WEBHOOK_VERIFY_TOKEN: z.string().min(1),

  // Weather API credentials
  OPENWEATHERMAP_API_KEY: z.string().min(1),

  // Security tokens
  JWT_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(32),

  // Logging configuration
  LOG_LEVEL: z
    .enum(["error", "warn", "info", "http", "debug"])
    .default("info")
    .optional(),
});

// Validate environment variables
const parseResult = environmentSchema.safeParse(process.env);

if (!parseResult.success) {
  console.error("[CONFIG] Environment validation failed:");
  parseResult.error.issues.forEach((issue) => {
    console.error(`[CONFIG] ${issue.path.join(".")}: ${issue.message}`);
  });
  console.error(
    "[CONFIG] Please check your .env file and ensure all required variables are set",
  );
  process.exit(1);
}

/**
 * Validated and type-safe configuration object
 * Includes computed values and API endpoints
 */
export const config = {
  ...parseResult.data,

  // Runtime environment flags
  isDevelopment: parseResult.data.NODE_ENV === "development",
  isProduction: parseResult.data.NODE_ENV === "production",
  isTest: parseResult.data.NODE_ENV === "test",

  // External API endpoints
  api: {
    strava: {
      authUrl: "https://www.strava.com/oauth/authorize",
      tokenUrl: "https://www.strava.com/oauth/token",
      baseUrl: "https://www.strava.com/api/v3",
    },
    openWeatherMap: {
      baseUrl: "https://api.openweathermap.org/data/2.5",
      oneCallUrl: "https://api.openweathermap.org/data/3.0/onecall",
    },
  },

  // Application constants
  auth: {
    sessionCookieName: "strava-weather-session",
    tokenExpiry: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
  },

  // Feature flags (can be extended with environment variables)
  features: {
    webhooksEnabled: true,
    rateLimitingEnabled: parseResult.data.NODE_ENV === "production",
  },
} as const;

// Export type for TypeScript support
export type Config = typeof config;

/**
 * Log configuration summary on startup (non-sensitive values only)
 */
if (config.isDevelopment) {
  console.log("[CONFIG] Environment configuration loaded:", {
    environment: config.NODE_ENV,
    port: config.PORT,
    appUrl: config.APP_URL,
    logLevel: config.LOG_LEVEL || "info",
    featuresEnabled: Object.entries(config.features)
      .filter(([_, enabled]) => enabled)
      .map(([feature]) => feature),
  });
}
