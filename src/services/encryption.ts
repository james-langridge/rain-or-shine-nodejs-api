import crypto from "crypto";
import { config } from "../config/environment";

/**
 * Encryption service for sensitive data using AES-256-GCM
 * Provides authenticated encryption with automatic key derivation
 */
export class EncryptionService {
  private readonly algorithm = "aes-256-gcm";
  private readonly keyLength = 32; // 256 bits
  private readonly ivLength = 16; // 128 bits
  private readonly tagLength = 16; // 128 bits
  private readonly saltLength = 32; // 256 bits
  private readonly iterations = 100000; // PBKDF2 iterations

  private encryptionKey: Buffer;

  constructor() {
    if (!config.ENCRYPTION_KEY) {
      throw new Error("ENCRYPTION_KEY is not set in environment variables");
    }

    // Derive a proper key from the provided encryption key using PBKDF2
    // This ensures we always have a 256-bit key regardless of input
    const salt = crypto
      .createHash("sha256")
      .update("strava-weather-static-salt")
      .digest();
    this.encryptionKey = crypto.pbkdf2Sync(
      config.ENCRYPTION_KEY,
      salt,
      this.iterations,
      this.keyLength,
      "sha256",
    );
  }

  /**
   * Encrypt a string value
   * Returns a string in format: salt:iv:authTag:encrypted
   */
  encrypt(plaintext: string): string {
    try {
      // Generate random salt for this encryption
      const salt = crypto.randomBytes(this.saltLength);

      // Derive encryption key for this specific encryption
      const key = crypto.pbkdf2Sync(
        this.encryptionKey,
        salt,
        1000, // Fewer iterations for per-encryption key
        this.keyLength,
        "sha256",
      );

      // Generate random IV
      const iv = crypto.randomBytes(this.ivLength);

      // Create cipher
      const cipher = crypto.createCipheriv(this.algorithm, key, iv);

      // Encrypt the data
      const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);

      // Get the auth tag
      const authTag = cipher.getAuthTag();

      // Combine salt, iv, authTag, and encrypted data
      const combined = Buffer.concat([salt, iv, authTag, encrypted]);

      // Return as base64 string
      return combined.toString("base64");
    } catch (error) {
      console.error("Encryption failed:", error);
      throw new Error("Failed to encrypt data");
    }
  }

  /**
   * Decrypt a string value
   * Expects input in format: salt:iv:authTag:encrypted (base64 encoded)
   */
  decrypt(encryptedData: string): string {
    try {
      // Decode from base64
      const combined = Buffer.from(encryptedData, "base64");

      // Extract components
      const salt = combined.slice(0, this.saltLength);
      const iv = combined.slice(
        this.saltLength,
        this.saltLength + this.ivLength,
      );
      const authTag = combined.slice(
        this.saltLength + this.ivLength,
        this.saltLength + this.ivLength + this.tagLength,
      );
      const encrypted = combined.slice(
        this.saltLength + this.ivLength + this.tagLength,
      );

      // Derive decryption key
      const key = crypto.pbkdf2Sync(
        this.encryptionKey,
        salt,
        1000,
        this.keyLength,
        "sha256",
      );

      // Create decipher
      const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
      decipher.setAuthTag(authTag);

      // Decrypt the data
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);

      return decrypted.toString("utf8");
    } catch (error) {
      console.error("Decryption failed:", error);
      throw new Error("Failed to decrypt data");
    }
  }

  /**
   * Check if a value is encrypted (basic check)
   */
  isEncrypted(value: string): boolean {
    try {
      // Check if it's a valid base64 string of expected length
      const decoded = Buffer.from(value, "base64");
      return decoded.length > this.saltLength + this.ivLength + this.tagLength;
    } catch {
      return false;
    }
  }

  /**
   * Safely encrypt a value (returns original if already encrypted)
   */
  safeEncrypt(value: string): string {
    if (this.isEncrypted(value)) {
      return value;
    }
    return this.encrypt(value);
  }

  /**
   * Safely decrypt a value (returns original if not encrypted)
   */
  safeDecrypt(value: string): string {
    if (!this.isEncrypted(value)) {
      return value;
    }
    return this.decrypt(value);
  }
}

// Create singleton instance
export const encryptionService = new EncryptionService();
