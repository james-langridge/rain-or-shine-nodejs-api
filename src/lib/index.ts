import { PrismaClient } from "@prisma/client";

// Global variable to store the Prisma client instance
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Create Prisma client instance
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

// In development, store the client in global to avoid creating multiple instances
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient } from "@prisma/client";

// Graceful shutdown
async function gracefulShutdown() {
  console.log("🔄 Disconnecting Prisma client...");
  await prisma.$disconnect();
  console.log("✅ Prisma client disconnected");
}

// Handle process termination
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
process.on("beforeExit", gracefulShutdown);
