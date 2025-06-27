import { Router, Request, Response, NextFunction } from "express";
import { webhookSubscriptionService } from "../services/webhookSubscription";
import { AppError } from "../middleware/errorHandler";
import { config } from "../config/environment";
import { userRepository } from "../lib";

const adminRouter = Router();

/**
 * Admin authentication middleware
 * In production, replace this with proper admin authentication
 */
function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const adminToken = req.headers["x-admin-token"] || req.query.admin_token;

  // Use ADMIN_TOKEN from config/env, or fallback to a default for development
  const expectedToken = config.ADMIN_TOKEN || "your-secret-admin-token";

  if (adminToken !== expectedToken) {
    throw new AppError("Unauthorized - Admin access required", 401);
  }

  next();
}

/**
 * @swagger
 * /api/admin/webhook/status:
 *   get:
 *     summary: View current webhook subscription status
 *     description: Check the current webhook subscription status with Strava
 *     tags:
 *       - Admin
 *     security:
 *       - AdminAuth: []
 *     responses:
 *       200:
 *         description: Webhook status information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     hasSubscription:
 *                       type: boolean
 *                     subscription:
 *                       type: object
 *                     webhookEndpoint:
 *                       type: string
 *                     verifyToken:
 *                       type: string
 *       401:
 *         description: Unauthorized - Admin access required
 */
adminRouter.get(
  "/webhook/status",
  requireAdminAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subscription = await webhookSubscriptionService.viewSubscription();

      res.json({
        success: true,
        data: {
          hasSubscription: !!subscription,
          subscription,
          webhookEndpoint: `${config.APP_URL}/api/strava/webhook`,
          verifyToken: config.STRAVA_WEBHOOK_VERIFY_TOKEN
            ? "configured"
            : "missing",
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @swagger
 * /api/admin/webhook/subscribe:
 *   post:
 *     summary: Create webhook subscription
 *     description: Create a new webhook subscription with Strava
 *     tags:
 *       - Admin
 *     security:
 *       - AdminAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               callback_url:
 *                 type: string
 *                 description: Optional custom callback URL (defaults to APP_URL/api/strava/webhook)
 *     responses:
 *       200:
 *         description: Webhook subscription created successfully
 *       400:
 *         description: Webhook endpoint is not accessible
 *       401:
 *         description: Unauthorized - Admin access required
 */
adminRouter.post(
  "/webhook/subscribe",
  requireAdminAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Use provided callback URL or default to APP_URL
      const callbackUrl =
        req.body.callback_url || `${config.APP_URL}/api/strava/webhook`;

      console.log(
        `📍 Creating webhook subscription with callback URL: ${callbackUrl}`,
      );

      // First verify the endpoint is accessible
      const isAccessible =
        await webhookSubscriptionService.verifyEndpoint(callbackUrl);

      if (!isAccessible) {
        throw new AppError(
          "Webhook endpoint is not accessible. Ensure your server is publicly accessible and the webhook endpoint is working.",
          400,
        );
      }

      // Create the subscription
      const subscription =
        await webhookSubscriptionService.createSubscription(callbackUrl);

      res.json({
        success: true,
        message: "Webhook subscription created successfully",
        data: {
          subscription,
          callbackUrl,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @swagger
 * /api/admin/webhook/unsubscribe:
 *   delete:
 *     summary: Delete webhook subscription
 *     description: Delete the current webhook subscription with Strava
 *     tags:
 *       - Admin
 *     security:
 *       - AdminAuth: []
 *     responses:
 *       200:
 *         description: Webhook subscription deleted successfully
 *       401:
 *         description: Unauthorized - Admin access required
 *       404:
 *         description: No webhook subscription found
 */
adminRouter.delete(
  "/webhook/unsubscribe",
  requireAdminAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // First get the current subscription
      const subscription = await webhookSubscriptionService.viewSubscription();

      if (!subscription) {
        throw new AppError("No webhook subscription found", 404);
      }

      // Delete the subscription
      await webhookSubscriptionService.deleteSubscription(subscription.id);

      res.json({
        success: true,
        message: "Webhook subscription deleted successfully",
        data: {
          deletedSubscriptionId: subscription.id,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @swagger
 * /api/admin/webhook/verify:
 *   get:
 *     summary: Test webhook endpoint
 *     description: Verify that the webhook endpoint is accessible and working
 *     tags:
 *       - Admin
 *     security:
 *       - AdminAuth: []
 *     responses:
 *       200:
 *         description: Webhook endpoint verification result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     callbackUrl:
 *                       type: string
 *                     verified:
 *                       type: boolean
 *       401:
 *         description: Unauthorized - Admin access required
 */
adminRouter.get(
  "/webhook/verify",
  requireAdminAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const callbackUrl = `${config.APP_URL}/api/strava/webhook`;

      const isAccessible =
        await webhookSubscriptionService.verifyEndpoint(callbackUrl);

      res.json({
        success: isAccessible,
        message: isAccessible
          ? "Webhook endpoint is accessible and working correctly"
          : "Webhook endpoint verification failed",
        data: {
          callbackUrl,
          verified: isAccessible,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @swagger
 * /api/admin/webhook/setup:
 *   post:
 *     summary: One-click webhook setup
 *     description: Automatically set up webhook subscription if none exists
 *     tags:
 *       - Admin
 *     security:
 *       - AdminAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               base_url:
 *                 type: string
 *                 description: Optional base URL for the webhook callback
 *     responses:
 *       200:
 *         description: Webhook setup completed
 *       400:
 *         description: Webhook endpoint is not accessible
 *       401:
 *         description: Unauthorized - Admin access required
 */
adminRouter.post(
  "/webhook/setup",
  requireAdminAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      console.log("🚀 Starting webhook setup process...");

      // Check for existing subscription
      const existing = await webhookSubscriptionService.viewSubscription();

      if (existing) {
        console.log("ℹ️ Found existing subscription:", existing);

        res.json({
          success: true,
          message: "Webhook subscription already exists",
          data: {
            subscription: existing,
            action: "existing",
          },
        });
        return;
      }

      // Use provided base URL or APP_URL
      const callbackUrl = req.body.base_url
        ? `${req.body.base_url}/api/strava/webhook`
        : `${config.APP_URL}/api/strava/webhook`;

      console.log(`📍 Setting up webhook with callback URL: ${callbackUrl}`);

      // Verify endpoint first
      const isAccessible =
        await webhookSubscriptionService.verifyEndpoint(callbackUrl);

      if (!isAccessible) {
        throw new AppError(
          `Webhook endpoint is not accessible at ${callbackUrl}. ` +
            "Ensure your server is publicly accessible and the webhook endpoint is working. " +
            "For local development, use a tool like ngrok to expose your local server.",
          400,
        );
      }

      // Create subscription
      const subscription =
        await webhookSubscriptionService.createSubscription(callbackUrl);

      res.json({
        success: true,
        message: "Webhook subscription created successfully",
        data: {
          subscription,
          callbackUrl,
          action: "created",
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @swagger
 * /api/admin/webhook/monitor:
 *   get:
 *     summary: Monitor webhook processing
 *     description: Shows recent webhook events and processing status
 *     tags:
 *       - Admin
 *     security:
 *       - AdminAuth: []
 *     responses:
 *       200:
 *         description: Webhook monitoring information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     webhook:
 *                       type: object
 *                       description: Current webhook subscription status
 *                     recentActivity:
 *                       type: object
 *                       description: Recent webhook activity
 *                     debugging:
 *                       type: object
 *                       description: Debugging tips and information
 *                     environment:
 *                       type: object
 *                       description: Environment configuration
 *       401:
 *         description: Unauthorized - Admin access required
 */
adminRouter.get(
  "/webhook/monitor",
  requireAdminAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get webhook subscription status
      const subscription = await webhookSubscriptionService.viewSubscription();

      // Get recent user activities (as a proxy for webhook activity)
      const recentUsers = await userRepository.findMany({
        limit: 10,
        orderBy: "updatedAt",
        orderDirection: "desc",
      });

      // Filter users updated in the last 24 hours
      const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentlyUpdatedUsers = recentUsers.filter(
        (user) => new Date(user.updatedAt) >= last24Hours,
      );

      // Check Vercel function logs status
      const functionStatus = {
        endpoint: "/api/strava/webhook",
        method: "POST",
        expectedResponse: 200,
        vercelDashboard: `https://vercel.com/${process.env.VERCEL_TEAM_ID || "your-team"}/${process.env.VERCEL_PROJECT_ID || "your-project"}/functions`,
      };

      res.json({
        success: true,
        data: {
          webhook: {
            hasSubscription: !!subscription,
            subscriptionId: subscription?.id,
            callbackUrl: subscription?.callback_url,
            createdAt: subscription?.created_at,
          },
          recentActivity: {
            usersUpdatedLast24h: recentlyUpdatedUsers.length,
            users: recentlyUpdatedUsers.map((u) => ({
              name: `${u.firstName} ${u.lastName}`,
              stravaId: u.stravaAthleteId,
              weatherEnabled: u.weatherEnabled,
              lastActive: u.updatedAt,
              tokenValid: new Date(u.tokenExpiresAt) > new Date(),
            })),
          },
          debugging: {
            tips: [
              "Check Vercel function logs for webhook POST requests",
              'Look for "Strava webhook event received" in logs',
              "Verify APP_URL matches your deployment URL",
              "Test with manual webhook: POST /api/strava/webhook/test",
              "Use debug endpoint: POST /api/strava/webhook/debug/:activityId",
            ],
            functionStatus,
          },
          environment: {
            nodeEnv: config.NODE_ENV,
            hasAppUrl: !!config.APP_URL,
            appUrl: config.APP_URL,
            isProduction: config.isProduction,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

export { adminRouter };
