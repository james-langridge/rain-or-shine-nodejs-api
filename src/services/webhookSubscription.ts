import { config } from "../config/environment";
import { logger } from "../utils/logger";

/**
 * Strava webhook subscription interface
 */
export interface WebhookSubscription {
  id: number;
  callback_url: string;
  created_at: string;
  updated_at: string;
}

/**
 * Error response from Strava API
 */
interface StravaErrorResponse {
  message?: string;
  errors?: Array<{
    resource: string;
    field: string;
    code: string;
  }>;
}

/**
 * Webhook subscription service
 *
 * Manages Strava webhook subscriptions for receiving real-time activity updates.
 * Implements the Strava Push Subscription API to create, view, and delete
 * webhook subscriptions.
 *
 * @see https://developers.strava.com/docs/webhooks/
 */
export class WebhookSubscriptionService {
  private readonly subscriptionUrl =
    "https://www.strava.com/api/v3/push_subscriptions";
  private readonly serviceLogger = logger.child({
    service: "WebhookSubscription",
  });

  /**
   * View current webhook subscription
   *
   * Retrieves the current webhook subscription for this application.
   * Strava allows only one subscription per application.
   *
   * @returns Current subscription or null if none exists
   * @throws Error if API request fails
   */
  async viewSubscription(): Promise<WebhookSubscription | null> {
    this.serviceLogger.debug("Checking for existing webhook subscription");

    try {
      const url = new URL(this.subscriptionUrl);
      url.searchParams.set("client_id", config.STRAVA_CLIENT_ID);
      url.searchParams.set("client_secret", config.STRAVA_CLIENT_SECRET);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.serviceLogger.error("Failed to retrieve webhook subscription", {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
        });
        throw new Error(
          `Failed to view subscription: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();

      // Strava returns an array of subscriptions
      if (Array.isArray(data) && data.length > 0) {
        const subscription = data[0];
        this.serviceLogger.info("Found existing webhook subscription", {
          subscriptionId: subscription.id,
          callbackUrl: subscription.callback_url,
          createdAt: subscription.created_at,
        });
        return subscription;
      }

      this.serviceLogger.debug("No existing webhook subscription found");
      return null;
    } catch (error) {
      this.serviceLogger.error("Error retrieving webhook subscription", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Create a new webhook subscription
   *
   * Creates a webhook subscription to receive Strava activity events.
   * Only one subscription is allowed per application - existing subscriptions
   * must be deleted before creating a new one.
   *
   * @param callbackUrl - Public HTTPS URL to receive webhook events
   * @returns Created subscription details
   * @throws Error if subscription already exists or creation fails
   */
  async createSubscription(callbackUrl: string): Promise<WebhookSubscription> {
    this.serviceLogger.info("Creating webhook subscription", { callbackUrl });

    try {
      // Verify no existing subscription
      const existing = await this.viewSubscription();
      if (existing) {
        this.serviceLogger.warn(
          "Cannot create subscription: one already exists",
          {
            existingId: existing.id,
            existingUrl: existing.callback_url,
          },
        );
        throw new Error(
          "Subscription already exists. Delete existing subscription first.",
        );
      }

      // Validate callback URL
      if (!callbackUrl.startsWith("https://")) {
        this.serviceLogger.error("Invalid callback URL: must use HTTPS", {
          callbackUrl,
        });
        throw new Error("Callback URL must use HTTPS protocol");
      }

      const formData = new URLSearchParams({
        client_id: config.STRAVA_CLIENT_ID,
        client_secret: config.STRAVA_CLIENT_SECRET,
        callback_url: callbackUrl,
        verify_token: config.STRAVA_WEBHOOK_VERIFY_TOKEN,
      });

      const response = await fetch(this.subscriptionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `${response.status} ${response.statusText}`;

        try {
          const errorData: StravaErrorResponse = JSON.parse(errorText);
          if (errorData.message) {
            errorMessage = errorData.message;
          }
        } catch {
          // Use raw error text if not JSON
          errorMessage = errorText || errorMessage;
        }

        this.serviceLogger.error("Failed to create webhook subscription", {
          status: response.status,
          error: errorMessage,
          callbackUrl,
        });

        throw new Error(`Failed to create subscription: ${errorMessage}`);
      }

      const subscription = await response.json();

      this.serviceLogger.info("Webhook subscription created successfully", {
        subscriptionId: subscription.id,
        callbackUrl: subscription.callback_url,
        createdAt: subscription.created_at,
      });

      return subscription;
    } catch (error) {
      this.serviceLogger.error("Error creating webhook subscription", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        callbackUrl,
      });
      throw error;
    }
  }

  /**
   * Delete a webhook subscription
   *
   * Removes the webhook subscription, stopping all webhook events.
   *
   * @param subscriptionId - ID of subscription to delete
   * @throws Error if deletion fails
   */
  async deleteSubscription(subscriptionId: number): Promise<void> {
    this.serviceLogger.info("Deleting webhook subscription", {
      subscriptionId,
    });

    try {
      const url = `${this.subscriptionUrl}/${subscriptionId}`;
      const params = new URLSearchParams({
        client_id: config.STRAVA_CLIENT_ID,
        client_secret: config.STRAVA_CLIENT_SECRET,
      });

      const response = await fetch(`${url}?${params}`, {
        method: "DELETE",
      });

      // 204 No Content is success for DELETE
      if (response.status === 204) {
        this.serviceLogger.info("Webhook subscription deleted successfully", {
          subscriptionId,
        });
        return;
      }

      if (!response.ok) {
        const errorText = await response.text();
        this.serviceLogger.error("Failed to delete webhook subscription", {
          subscriptionId,
          status: response.status,
          error: errorText,
        });
        throw new Error(
          `Failed to delete subscription: ${response.status} ${response.statusText}`,
        );
      }
    } catch (error) {
      this.serviceLogger.error("Error deleting webhook subscription", {
        subscriptionId,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Verify webhook endpoint accessibility
   *
   * Tests if the webhook callback URL is publicly accessible and
   * correctly implements the Strava webhook verification protocol.
   *
   * @param callbackUrl - URL to verify
   * @returns True if endpoint is accessible and responds correctly
   */
  async verifyEndpoint(callbackUrl: string): Promise<boolean> {
    this.serviceLogger.debug("Verifying webhook endpoint accessibility", {
      callbackUrl,
    });

    const testChallenge = `test_challenge_${Date.now()}`;

    try {
      const testUrl = new URL(callbackUrl);
      testUrl.searchParams.set("hub.mode", "subscribe");
      testUrl.searchParams.set(
        "hub.verify_token",
        config.STRAVA_WEBHOOK_VERIFY_TOKEN,
      );
      testUrl.searchParams.set("hub.challenge", testChallenge);

      const response = await fetch(testUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        // Short timeout for verification
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        this.serviceLogger.warn("Webhook endpoint returned non-OK status", {
          callbackUrl,
          status: response.status,
          statusText: response.statusText,
        });
        return false;
      }

      const data = await response.json();

      if (data["hub.challenge"] === testChallenge) {
        this.serviceLogger.info("Webhook endpoint verified successfully", {
          callbackUrl,
        });
        return true;
      }

      this.serviceLogger.warn("Webhook endpoint returned incorrect challenge", {
        callbackUrl,
        expected: testChallenge,
        received: data["hub.challenge"],
      });
      return false;
    } catch (error) {
      this.serviceLogger.error("Failed to verify webhook endpoint", {
        callbackUrl,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }
}

// Export singleton instance
export const webhookSubscriptionService = new WebhookSubscriptionService();
