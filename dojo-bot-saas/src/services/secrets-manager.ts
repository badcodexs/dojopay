import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';

const kmsClient = new KMSClient({});
const keyId = process.env.KMS_KEY_ID;

const decryptedSecretsCache = new Map<string, string>();
const metaTokensCache = new Map<string, string>();

export const secretsManager = {
  encryptSecret: async (plaintext: string): Promise<string> => {
    if (!keyId) {
      console.warn("KMS_KEY_ID not found. Returning plaintext (not recommended).");
      return plaintext;
    }
    try {
      const command = new EncryptCommand({
        KeyId: keyId,
        Plaintext: Buffer.from(plaintext, 'utf-8'),
      });
      const response = await kmsClient.send(command);
      return Buffer.from(response.CiphertextBlob!).toString('base64');
    } catch (error) {
      console.error("Error encrypting secret with KMS:", error);
      throw error;
    }
  },

  getDecryptedSecret: async (
    tenantId: string,
    adminPass?: string,
    adminPassEncrypted?: string
  ): Promise<string | undefined> => {
    if (decryptedSecretsCache.has(tenantId)) {
      return decryptedSecretsCache.get(tenantId);
    }

    // Lazy migration: tenants not yet re-saved with KMS encryption still carry a plaintext password.
    if (!adminPassEncrypted) {
      if (adminPass) {
        console.log(`[Secrets Manager] Falling back to plaintext password for tenant ${tenantId}`);
        decryptedSecretsCache.set(tenantId, adminPass);
        return adminPass;
      }
      return undefined;
    }

    try {
      const command = new DecryptCommand({
        CiphertextBlob: Buffer.from(adminPassEncrypted, 'base64'),
      });
      const response = await kmsClient.send(command);
      const plaintext = Buffer.from(response.Plaintext!).toString('utf-8');

      decryptedSecretsCache.set(tenantId, plaintext);
      return plaintext;
    } catch (error) {
      console.error(`[Secrets Manager] Error decrypting secret for tenant ${tenantId}:`, error);
      throw error;
    }
  }
,

  getDecryptedMetaToken: async (
    tenantPhone: string,
    fallbackPlainToken?: string,
    encryptedToken?: string
  ): Promise<string | undefined> => {
    if (metaTokensCache.has(tenantPhone)) {
      return metaTokensCache.get(tenantPhone);
    }

    if (!encryptedToken) {
      if (fallbackPlainToken) {
        metaTokensCache.set(tenantPhone, fallbackPlainToken);
        return fallbackPlainToken;
      }
      return undefined;
    }

    try {
      const command = new DecryptCommand({
        CiphertextBlob: Buffer.from(encryptedToken, 'base64'),
      });
      const response = await kmsClient.send(command);
      const plaintext = Buffer.from(response.Plaintext!).toString('utf-8');

      metaTokensCache.set(tenantPhone, plaintext);
      return plaintext;
    } catch (error) {
      console.error("[Secrets Manager] Error decrypting Meta Token:", error);
      throw error;
    }
  }
};
