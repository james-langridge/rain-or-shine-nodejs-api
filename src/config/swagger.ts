import swaggerJsdoc from "swagger-jsdoc";
import { config } from "./environment";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Strava Weather API",
      version: "1.0.0",
      description: "API for integrating Strava activities with weather data",
      contact: {
        name: "API Support",
      },
    },
    servers: [
      {
        url: config.APP_URL || "http://localhost:5002",
        description: config.isProduction
          ? "Production server"
          : "Development server",
      },
    ],
    components: {
      securitySchemes: {
        SessionAuth: {
          type: "apiKey",
          in: "cookie",
          name: "connect.sid",
          description: "Session-based authentication using cookies",
        },
        AdminAuth: {
          type: "apiKey",
          in: "header",
          name: "x-admin-token",
          description: "Admin authentication token",
        },
      },
    },
    security: [],
  },
  apis: config.isProduction ? ["./dist/routes/*.js"] : ["./src/routes/*.ts"],
};

export const swaggerSpec = swaggerJsdoc(options);
