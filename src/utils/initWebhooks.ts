import { config } from "../config/environment";
import { setupWebhookOnStartup } from "../services/startupWebhookSetup";
import { logger } from "../utils/logger";

/**
 * Webhook initialization state
 *
 * Tracks whether webhook setup has been initiated to prevent
 * multiple initialization attempts during application lifecycle.
 */
let initialized = false;

/**
 * Ensure webhooks are initialized for production environment
 *
 * This function provides idempotent webhook initialization, ensuring
 * webhooks are set up exactly once during application startup in
 * production environments.
 *
 * Features:
 * - Idempotent: Safe to call multiple times
 * - Non-blocking: Runs asynchronously without blocking startup
 * - Fault-tolerant: Failures don't crash the application
 * - Environment-aware: Only runs in production
 *
 * In development environments, webhook setup should be handled
 * manually or through the startup service with ngrok configuration.
 *
 * @returns Promise that resolves immediately (setup runs async)
 */
export async function ensureWebhooksInitialized(): Promise<void> {
  // Skip if already initialized
  if (initialized) {
    logger.debug("Webhook initialization already completed, skipping", {
      initialized,
      environment: config.isProduction ? "production" : "development",
    });
    return;
  }

  // Skip in non-production environments
  if (!config.isProduction) {
    logger.debug(
      "Skipping webhook initialization in non-production environment",
      {
        environment: process.env.NODE_ENV,
        isProduction: config.isProduction,
      },
    );
    return;
  }

  // Mark as initialized before starting async operation
  initialized = true;

  logger.info("Initiating webhook setup for production environment", {
    appUrl: config.APP_URL,
    timestamp: new Date().toISOString(),
  });

  // Run webhook setup asynchronously to avoid blocking application startup
  setupWebhookOnStartup()
    .then(() => {
      logger.info("Webhook setup completed successfully");
    })
    .catch((error) => {
      // Log error but don't throw - webhook failures shouldn't crash the app
      logger.error("Webhook setup failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        message: "Application will continue without webhook functionality",
      });

      // Note: We don't reset 'initialized' to prevent retry attempts
      // that could cause issues. Manual intervention or restart required.
    });
}

/**
 * Reset initialization state
 *
 * This function is primarily for testing purposes or manual
 * re-initialization scenarios. Use with caution in production.
 *
 * @internal
 */
export function resetWebhookInitialization(): void {
  logger.warn("Resetting webhook initialization state", {
    previousState: initialized,
    environment: config.isProduction ? "production" : "development",
  });

  initialized = false;
}

/**
 * Get current initialization state
 *
 * @returns Current initialization state
 * @internal
 */
export function isWebhookInitialized(): boolean {
  return initialized;
}
