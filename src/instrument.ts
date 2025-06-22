import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { config } from "./config/environment";

// Validate Sentry DSN
if (!process.env.SENTRY_DSN || !process.env.PROXY_AUTH_SECRET) {
  console.error("❌ SENTRY_DSN environment variable is not set!");
  console.error("Please set SENTRY_DSN in your .env file or environment");
  process.exit(1);
}

Sentry.init({
  // Use environment variable
  dsn: process.env.SENTRY_DSN,
  environment: config.NODE_ENV,
  tunnel: process.env.SENTRY_TUNNEL_URL,
  transportOptions: {
    headers: {
      "X-Proxy-Auth": process.env.PROXY_AUTH_SECRET,
    },
  },

  integrations: [nodeProfilingIntegration()],

  tracesSampleRate: config.isProduction ? 0.1 : 1.0, // 10% in prod
  profilesSampleRate: config.isProduction ? 0.1 : 1.0, // 10% in prod

  sendDefaultPii: !config.isProduction, // No PII in production

  debug: true,

  beforeSend(event, hint) {
    console.log("=== Sentry beforeSend ===");
    console.log("Event type:", event.level);
    console.log("Event ID:", event.event_id);
    console.log(
      "DSN being used:",
      process.env.SENTRY_DSN?.substring(0, 50) + "...",
    );

    // Log any error details
    if (hint.originalException) {
      console.log("Original error:", hint.originalException);
    }

    return event;
  },

  beforeSendTransaction(event) {
    console.log("=== Sentry beforeSendTransaction ===");
    console.log("Transaction:", event.transaction);
    return event;
  },

  // Additional error handling
  onFatalError: (error) => {
    console.error("Sentry Fatal Error:", error);
  },
});

console.log(
  "Sentry initialized with DSN:",
  process.env.SENTRY_DSN?.substring(0, 50) + "...",
);
