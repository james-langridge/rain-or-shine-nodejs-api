import { config } from "../config/environment";
import { webhookSubscriptionService } from "./webhookSubscription";
import { logger } from "../utils/logger";

/**
 * Webhook setup service
 *
 * Manages automatic webhook subscription setup on application startup
 * and cleanup on shutdown. Handles both production and development
 * environments with appropriate configuration.
 */

/**
 * Setup Strava webhook subscription on application startup
 *
 * This function:
 * 1. Checks for existing webhook subscriptions
 * 2. Creates a new subscription if none exists
 * 3. Verifies endpoint accessibility before creation
 * 4. Handles different environments (production vs development)
 *
 * In development, requires ngrok for public URL exposure.
 * In production, uses the configured APP_URL.
 *
 * @returns Promise that resolves when setup is complete
 */
export async function setupWebhookOnStartup(): Promise<void> {
  logger.info("Starting webhook subscription setup", {
    environment: config.isProduction ? "production" : "development",
    appUrl: config.APP_URL,
    hasVercelUrl: !!process.env.VERCEL_URL,
  });

  try {
    // Check for existing subscription
    logger.debug("Checking for existing webhook subscription");

    const existingSubscription =
      await webhookSubscriptionService.viewSubscription();

    if (existingSubscription) {
      logger.info("Webhook subscription already exists", {
        subscriptionId: existingSubscription.id,
        callbackUrl: existingSubscription.callback_url,
      });
      return;
    }

    logger.info(
      "No existing webhook subscription found, creating new subscription",
    );

    // Determine callback URL based on environment
    const callbackUrl = await determineCallbackUrl();

    if (!callbackUrl) {
      // determineCallbackUrl logs the reason for returning null
      return;
    }

    logger.info("Webhook callback URL determined", {
      callbackUrl,
      environment: config.isProduction ? "production" : "development",
    });

    // Verify endpoint accessibility
    logger.debug("Verifying webhook endpoint accessibility", { callbackUrl });

    const isAccessible =
      await webhookSubscriptionService.verifyEndpoint(callbackUrl);

    if (!isAccessible) {
      logger.error("Webhook endpoint verification failed", {
        callbackUrl,
        message: "Endpoint is not publicly accessible",
      });

      if (!config.isProduction) {
        logger.info("Development webhook setup instructions", {
          steps: [
            "Ensure ngrok is running: ngrok http 3001",
            "Update NGROK_URL in .env with the https URL from ngrok",
            "Restart the application",
          ],
        });
      }
      return;
    }

    logger.debug("Webhook endpoint verified as accessible");

    // Create subscription
    const subscription =
      await webhookSubscriptionService.createSubscription(callbackUrl);

    logger.info("Webhook subscription created successfully", {
      subscriptionId: subscription.id,
      callbackUrl: subscription.callback_url,
      message: "Application will now receive Strava activity events",
    });
  } catch (error) {
    // Non-fatal error - application continues without webhooks
    logger.error("Failed to setup webhook subscription", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      message: "Application will continue without webhook functionality",
    });
  }
}

/**
 * Cleanup webhook subscription on application shutdown
 *
 * Removes webhook subscription during graceful shutdown.
 * Only runs in development or when explicitly enabled via
 * CLEANUP_WEBHOOK_ON_SHUTDOWN environment variable.
 *
 * This prevents orphaned subscriptions during development
 * but preserves them in production deployments.
 *
 * @returns Promise that resolves when cleanup is complete
 */
export async function cleanupWebhookOnShutdown(): Promise<void> {
  const shouldCleanup =
    config.isDevelopment || process.env.CLEANUP_WEBHOOK_ON_SHUTDOWN === "true";

  if (!shouldCleanup) {
    logger.debug("Webhook cleanup skipped", {
      isDevelopment: config.isDevelopment,
      cleanupEnvVar: process.env.CLEANUP_WEBHOOK_ON_SHUTDOWN,
    });
    return;
  }

  try {
    logger.info("Starting webhook subscription cleanup");

    const subscription = await webhookSubscriptionService.viewSubscription();

    if (!subscription) {
      logger.debug("No webhook subscription found to cleanup");
      return;
    }

    await webhookSubscriptionService.deleteSubscription(subscription.id);

    logger.info("Webhook subscription cleaned up successfully", {
      subscriptionId: subscription.id,
    });
  } catch (error) {
    logger.error("Failed to cleanup webhook subscription", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

/**
 * Determine the appropriate callback URL based on environment
 *
 * Production: Uses APP_URL from configuration
 * Development: Requires NGROK_URL for public accessibility
 *
 * @returns Callback URL or null if unable to determine
 */
async function determineCallbackUrl(): Promise<string | null> {
  if (config.isProduction) {
    return `${config.APP_URL}/api/strava/webhook`;
  }

  // Development mode requires ngrok
  const ngrokUrl = process.env.NGROK_URL;

  if (!ngrokUrl) {
    logger.warn("Development mode: No NGROK_URL configured", {
      instructions: {
        step1: "Install ngrok from https://ngrok.com",
        step2: "Run: ngrok http 3001",
        step3: "Add NGROK_URL=https://your-subdomain.ngrok.io to .env",
        step4: "Restart the application",
      },
      message: "Webhooks disabled in development without ngrok",
    });
    return null;
  }

  // Validate ngrok URL format
  if (!ngrokUrl.startsWith("https://") || !ngrokUrl.includes("ngrok")) {
    logger.error("Invalid NGROK_URL format", {
      ngrokUrl,
      expectedFormat: "https://subdomain.ngrok.io",
    });
    return null;
  }

  return `${ngrokUrl}/api/strava/webhook`;
}

/**
 * Register shutdown handlers for graceful cleanup
 *
 * This should be called during application initialization to ensure
 * proper cleanup when the process terminates.
 */
export function registerShutdownHandlers(): void {
  const shutdownHandler = async (signal: string) => {
    logger.info("Shutdown signal received", { signal });
    await cleanupWebhookOnShutdown();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
  process.on("SIGINT", () => shutdownHandler("SIGINT"));

  logger.debug("Shutdown handlers registered");
}
