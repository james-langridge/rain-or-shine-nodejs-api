import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { config } from "./config/environment";

// Validate Sentry configuration
if (!process.env.SENTRY_DSN) {
  console.warn("SENTRY_DSN not configured - error tracking disabled");
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: config.NODE_ENV,

  // Use tunnel if configured (for IP blocking workaround)
  tunnel: process.env.SENTRY_TUNNEL_URL,

  // Only enable in production with DSN configured
  enabled: config.isProduction && !!process.env.SENTRY_DSN,

  integrations: [nodeProfilingIntegration()],

  // Reduce sample rates to avoid rate limiting
  tracesSampleRate: config.isProduction ? 0.05 : 1.0, // 5% in prod
  profilesSampleRate: config.isProduction ? 0.01 : 1.0, // 1% in prod

  // Don't send PII in production
  sendDefaultPii: false,

  // Debug only in development or when explicitly enabled
  debug: config.isDevelopment || process.env.SENTRY_DEBUG === "true",

  // Transport options for debugging
  transportOptions: {
    // Add timeout
    keepAlive: true,
    // Log transport events in debug mode
    ...(process.env.SENTRY_DEBUG === "true" && {
      beforeSend: (request: any) => {
        console.log("[Sentry Transport] Sending to:", request.url);
        console.log("[Sentry Transport] Body size:", request.body?.length || 0);
      },
    }),
  },

  // Add retry backoff for rate limiting
  beforeSend(event, hint) {
    // Don't send in development unless explicitly enabled
    if (config.isDevelopment && !process.env.FORCE_SENTRY_DEV) {
      console.log("[Sentry] Event suppressed in development:", event.event_id);
      return null;
    }

    // Log event details in debug mode
    if (process.env.SENTRY_DEBUG === "true") {
      console.log("[Sentry] Sending event:", {
        eventId: event.event_id,
        level: event.level,
        message: event.message,
        tunnel: !!process.env.SENTRY_TUNNEL_URL,
      });
    }

    return event;
  },

  // Error filtering
  ignoreErrors: [
    // Ignore known non-critical errors
    "ResizeObserver loop limit exceeded",
    "Non-Error promise rejection captured",
    /^Webhook verification failed/,
  ],
});

// Add to global for rate limiting
declare global {
  var __sentryLastSent: number | undefined;
}

// Log initialization status
console.log("[Sentry] Initialization status:", {
  enabled: !!process.env.SENTRY_DSN,
  environment: config.NODE_ENV,
  tunnel: process.env.SENTRY_TUNNEL_URL ? "configured" : "not configured",
  debug: config.isDevelopment || process.env.SENTRY_DEBUG === "true",
});

// Test Sentry configuration
export function testSentry() {
  if (!process.env.SENTRY_DSN) {
    console.log("[Sentry] Cannot test - no DSN configured");
    return;
  }

  console.log("[Sentry] Sending test error...");

  try {
    throw new Error("Test Sentry error - ignore this!");
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        test: true,
        source: "manual-test",
      },
    });
    console.log("[Sentry] Test error sent - check dashboard");
  }
}
