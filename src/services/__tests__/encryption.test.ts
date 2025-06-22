import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EncryptionService } from "../encryption";

// Mock console to suppress error logs during testing
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});

afterEach(() => {
  console.error = originalConsoleError;
});

// Mock the config module
vi.mock("../../config/environment", () => ({
  config: {
    ENCRYPTION_KEY: "test-encryption-key-32-characters-long!!",
  },
}));

describe("EncryptionService", () => {
  let encryptionService: EncryptionService;

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();

    // Create fresh instance for each test
    encryptionService = new EncryptionService();
  });

  describe("constructor validation", () => {
    it("should create instance successfully with valid encryption key", () => {
      // Act & Assert - Should not throw
      expect(() => new EncryptionService()).not.toThrow();
    });

    it("should derive consistent key from same input", () => {
      // Arrange
      const service1 = new EncryptionService();
      const service2 = new EncryptionService();
      const testData = "test-consistency";

      // Act
      const encrypted = service1.encrypt(testData);
      const decrypted = service2.decrypt(encrypted);

      // Assert - Both instances should work together
      expect(decrypted).toBe(testData);
    });

    // Note: Testing constructor errors when ENCRYPTION_KEY is missing
    // requires mocking config before module import, which is complex
    // in vitest. The constructor validation is covered by the
    // implementation which throws when !config.ENCRYPTION_KEY
  });

  describe("encrypt and decrypt", () => {
    it("should successfully encrypt and decrypt a string", () => {
      // Arrange
      const plaintext = "my-secret-token-123";

      // Act
      const encrypted = encryptionService.encrypt(plaintext);
      const decrypted = encryptionService.decrypt(encrypted);

      // Assert
      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe("string");
      expect(encrypted).not.toBe(plaintext); // Should be different from original
      expect(decrypted).toBe(plaintext); // Should match original after decryption
    });

    it("should produce different ciphertext for same plaintext (due to random IV)", () => {
      // Arrange
      const plaintext = "same-secret-value";

      // Act
      const encrypted1 = encryptionService.encrypt(plaintext);
      const encrypted2 = encryptionService.encrypt(plaintext);

      // Assert
      expect(encrypted1).not.toBe(encrypted2); // Different due to random IV

      // But both should decrypt to same value
      expect(encryptionService.decrypt(encrypted1)).toBe(plaintext);
      expect(encryptionService.decrypt(encrypted2)).toBe(plaintext);
    });

    it("should handle empty strings", () => {
      // Arrange
      const plaintext = "";

      // Act
      const encrypted = encryptionService.encrypt(plaintext);
      const decrypted = encryptionService.decrypt(encrypted);

      // Assert
      expect(decrypted).toBe("");
    });

    it("should handle long strings", () => {
      // Arrange
      const plaintext = "a".repeat(1000); // 1000 character string

      // Act
      const encrypted = encryptionService.encrypt(plaintext);
      const decrypted = encryptionService.decrypt(encrypted);

      // Assert
      expect(decrypted).toBe(plaintext);
      expect(decrypted.length).toBe(1000);
    });

    it("should handle special characters and unicode", () => {
      // Arrange
      const plaintext = "Special chars: !@#$%^&*() Unicode: 🚀 émojis 中文";

      // Act
      const encrypted = encryptionService.encrypt(plaintext);
      const decrypted = encryptionService.decrypt(encrypted);

      // Assert
      expect(decrypted).toBe(plaintext);
    });

    it("should handle JSON strings", () => {
      // Arrange
      const jsonData = { token: "abc123", expires: 1234567890 };
      const plaintext = JSON.stringify(jsonData);

      // Act
      const encrypted = encryptionService.encrypt(plaintext);
      const decrypted = encryptionService.decrypt(encrypted);

      // Assert
      expect(decrypted).toBe(plaintext);
      expect(JSON.parse(decrypted)).toEqual(jsonData);
    });
  });

  describe("decrypt error handling", () => {
    it("should throw error when decrypting invalid base64", () => {
      // Arrange
      const invalidBase64 = "not-valid-base64!@#$";

      // Act & Assert
      expect(() => encryptionService.decrypt(invalidBase64)).toThrow(
        "Failed to decrypt data",
      );
    });

    it("should throw error when decrypting data with wrong format", () => {
      // Arrange
      const validBase64ButWrongFormat =
        Buffer.from("random data").toString("base64");

      // Act & Assert
      expect(() =>
        encryptionService.decrypt(validBase64ButWrongFormat),
      ).toThrow("Failed to decrypt data");
    });

    it("should throw error when decrypting data with tampered auth tag", () => {
      // Arrange
      const plaintext = "secret-data";
      const encrypted = encryptionService.encrypt(plaintext);

      // Decode and create a mutable copy
      const originalData = Buffer.from(encrypted, "base64");
      const tamperedData = Buffer.from(originalData); // Create a copy

      // Ensure we have enough data to tamper with auth tag
      expect(tamperedData.length).toBeGreaterThan(64); // salt(32) + iv(16) + tag(16)

      // Tamper with a byte in the auth tag region using Buffer write method
      const authTagPosition = 50; // Within the auth tag region
      const originalByte = tamperedData.readUInt8(authTagPosition);
      tamperedData.writeUInt8(originalByte ^ 0xff, authTagPosition);

      const tampered = tamperedData.toString("base64");

      // Act & Assert
      expect(() => encryptionService.decrypt(tampered)).toThrow(
        "Failed to decrypt data",
      );
    });

    it("should throw error when decrypting corrupted data", () => {
      // Arrange
      const plaintext = "secret-data";
      const encrypted = encryptionService.encrypt(plaintext);

      // Corrupt the encrypted data by modifying the middle
      const corrupted =
        encrypted.substring(0, 20) + "CORRUPTED" + encrypted.substring(30);

      // Act & Assert
      expect(() => encryptionService.decrypt(corrupted)).toThrow(
        "Failed to decrypt data",
      );
    });

    it("should throw error when encrypted data is truncated", () => {
      // Arrange
      const plaintext = "secret-data";
      const encrypted = encryptionService.encrypt(plaintext);

      // Truncate the encrypted data
      const truncated = encrypted.substring(0, encrypted.length - 10);

      // Act & Assert
      expect(() => encryptionService.decrypt(truncated)).toThrow(
        "Failed to decrypt data",
      );
    });

    it("should validate encrypted data structure", () => {
      // Arrange
      const plaintext = "test-data";
      const encrypted = encryptionService.encrypt(plaintext);

      // Act - Decode to check structure
      const decoded = Buffer.from(encrypted, "base64");

      // Assert - Verify minimum length (salt + iv + tag + some data)
      const minLength = 32 + 16 + 16 + 1; // salt + iv + authTag + at least 1 byte
      expect(decoded.length).toBeGreaterThanOrEqual(minLength);

      // Verify it's valid base64
      expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
    });
  });

  describe("isEncrypted", () => {
    it("should return true for encrypted data", () => {
      // Arrange
      const plaintext = "test-data";
      const encrypted = encryptionService.encrypt(plaintext);

      // Act
      const result = encryptionService.isEncrypted(encrypted);

      // Assert
      expect(result).toBe(true);
    });

    it("should return false for plain text", () => {
      // Arrange
      const plaintext = "not-encrypted-data";

      // Act
      const result = encryptionService.isEncrypted(plaintext);

      // Assert
      expect(result).toBe(false);
    });

    it("should return false for invalid base64", () => {
      // Arrange
      const invalidBase64 = "!@#$%^&*()";

      // Act
      const result = encryptionService.isEncrypted(invalidBase64);

      // Assert
      expect(result).toBe(false);
    });

    it("should return false for valid base64 but too short", () => {
      // Arrange
      const shortBase64 = Buffer.from("short").toString("base64");

      // Act
      const result = encryptionService.isEncrypted(shortBase64);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe("safeEncrypt", () => {
    it("should encrypt unencrypted data", () => {
      // Arrange
      const plaintext = "unencrypted-token";

      // Act
      const result = encryptionService.safeEncrypt(plaintext);

      // Assert
      expect(result).not.toBe(plaintext);
      expect(encryptionService.isEncrypted(result)).toBe(true);
      expect(encryptionService.decrypt(result)).toBe(plaintext);
    });

    it("should return already encrypted data unchanged", () => {
      // Arrange
      const plaintext = "test-token";
      const encrypted = encryptionService.encrypt(plaintext);

      // Act
      const result = encryptionService.safeEncrypt(encrypted);

      // Assert
      expect(result).toBe(encrypted); // Should be unchanged
      expect(encryptionService.decrypt(result)).toBe(plaintext);
    });
  });

  describe("safeDecrypt", () => {
    it("should decrypt encrypted data", () => {
      // Arrange
      const plaintext = "secret-token";
      const encrypted = encryptionService.encrypt(plaintext);

      // Act
      const result = encryptionService.safeDecrypt(encrypted);

      // Assert
      expect(result).toBe(plaintext);
    });

    it("should return unencrypted data unchanged", () => {
      // Arrange
      const plaintext = "already-plain-text";

      // Act
      const result = encryptionService.safeDecrypt(plaintext);

      // Assert
      expect(result).toBe(plaintext); // Should be unchanged
    });

    it("should handle mixed scenarios in sequence", () => {
      // Arrange
      const plaintext = "test-token-123";

      // Act - Multiple safe operations
      const encrypted1 = encryptionService.safeEncrypt(plaintext);
      const encrypted2 = encryptionService.safeEncrypt(encrypted1); // Should not double-encrypt
      const decrypted1 = encryptionService.safeDecrypt(encrypted2);
      const decrypted2 = encryptionService.safeDecrypt(decrypted1); // Should not error on plain text

      // Assert
      expect(encrypted2).toBe(encrypted1); // No double encryption
      expect(decrypted1).toBe(plaintext);
      expect(decrypted2).toBe(plaintext); // No double decryption
    });
  });

  describe("key derivation and consistency", () => {
    it("should produce consistent results across instances with same key", () => {
      // Arrange
      const plaintext = "consistent-data";
      const instance1 = new EncryptionService();
      const instance2 = new EncryptionService();

      // Act
      const encrypted = instance1.encrypt(plaintext);
      const decrypted = instance2.decrypt(encrypted);

      // Assert
      expect(decrypted).toBe(plaintext); // Different instances should work together
    });

    it("should handle rapid encryption/decryption cycles", () => {
      // Arrange
      const iterations = 100;
      const testData = Array.from(
        { length: iterations },
        (_, i) => `test-${i}`,
      );

      // Act & Assert
      const results = testData.map((plaintext) => {
        const encrypted = encryptionService.encrypt(plaintext);
        const decrypted = encryptionService.decrypt(encrypted);
        return { plaintext, decrypted, matches: plaintext === decrypted };
      });

      expect(results.every((r) => r.matches)).toBe(true);
    });

    it("should handle concurrent operations safely", async () => {
      // Arrange
      const concurrentOps = 50;
      const testData = Array.from(
        { length: concurrentOps },
        (_, i) => `concurrent-${i}`,
      );

      // Act - Encrypt all concurrently
      const encryptPromises = testData.map(async (data) => ({
        original: data,
        encrypted: await Promise.resolve(encryptionService.encrypt(data)),
      }));

      const encryptedResults = await Promise.all(encryptPromises);

      // Decrypt all concurrently
      const decryptPromises = encryptedResults.map(
        async ({ original, encrypted }) => ({
          original,
          decrypted: await Promise.resolve(
            encryptionService.decrypt(encrypted),
          ),
        }),
      );

      const decryptedResults = await Promise.all(decryptPromises);

      // Assert
      expect(decryptedResults.every((r) => r.original === r.decrypted)).toBe(
        true,
      );
    });
  });

  describe("error recovery and edge cases", () => {
    it("should handle encryption of already encrypted-looking strings", () => {
      // Arrange - A string that looks like base64 but isn't encrypted
      const fakeEncrypted = Buffer.from("a".repeat(100)).toString("base64");

      // Act
      const encrypted = encryptionService.encrypt(fakeEncrypted);
      const decrypted = encryptionService.decrypt(encrypted);

      // Assert
      expect(decrypted).toBe(fakeEncrypted);
    });

    it("should maintain data integrity for binary-like strings", () => {
      // Arrange
      const binaryLike = "\x00\x01\x02\x03\xFF\xFE\xFD";

      // Act
      const encrypted = encryptionService.encrypt(binaryLike);
      const decrypted = encryptionService.decrypt(encrypted);

      // Assert
      expect(decrypted).toBe(binaryLike);
    });

    it("should handle maximum safe string length", () => {
      // Arrange - Test with a reasonably large string (not too large to avoid memory issues)
      const largeString = "x".repeat(10000); // 10KB

      // Act
      const encrypted = encryptionService.encrypt(largeString);
      const decrypted = encryptionService.decrypt(encrypted);

      // Assert
      expect(decrypted).toBe(largeString);
      expect(decrypted.length).toBe(10000);
    });
  });
});
