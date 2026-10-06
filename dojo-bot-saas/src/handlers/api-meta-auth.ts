import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import * as jwt from 'jsonwebtoken';
import { secretsManager } from '../services/secrets-manager';

const ssmClient = new SSMClient({});
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const TABLE_NAME = process.env.DYNAMODB_TABLE!;
const META_APP_ID = process.env.META_APP_ID!;
const META_APP_SECRET = process.env.META_APP_SECRET!;

let cachedJwtSecret: string | null = null;
let lastCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

const getJwtSecret = async (): Promise<string> => {
  const now = Date.now();
  if (cachedJwtSecret && (now - lastCacheTime < CACHE_TTL)) {
    return cachedJwtSecret;
  }
  const response = await ssmClient.send(new GetParameterCommand({
    Name: '/dojopay/prod/jwt-secret',
    WithDecryption: true,
  }));
  cachedJwtSecret = response.Parameter!.Value!;
  lastCacheTime = now;
  return cachedJwtSecret;
};

export const handler = async (event: any): Promise<any> => {
  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
    }

    const token = authHeader.split(' ')[1];
    const secret = await getJwtSecret();
    let decoded: any;
    try {
      decoded = jwt.verify(token, secret);
    } catch (err) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Token inválido o expirado.' }) };
    }

    const tenantPhone = decoded.phone;

    const body = JSON.parse(event.body || '{}');
    const { metaAccessToken } = body;

    if (!metaAccessToken) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parámetros de Meta.' }) };
    }

    let finalWabaId = body.metaWabaId;
    let finalPhoneId = body.metaPhoneNumberId;

    if (!finalWabaId || finalWabaId === 'PENDING_WABA_ID' || finalPhoneId === 'PENDING_PHONE_ID') {
      try {
        console.log(`[Meta API] Obteniendo WABA ID desde debug_token...`);
        const debugUrl = `https://graph.facebook.com/v20.0/debug_token?input_token=${metaAccessToken}&access_token=${META_APP_ID}|${META_APP_SECRET}`;
        const debugRes = await fetch(debugUrl);
        const debugData: any = await debugRes.json();

        if (!debugRes.ok || debugData.error) {
          throw new Error('Error validando token con Meta: ' + JSON.stringify(debugData));
        }

        const granularScopes = debugData.data?.granular_scopes || [];
        const wabaScope = granularScopes.find((s: any) => s.scope === 'whatsapp_business_management');

        if (wabaScope && wabaScope.target_ids && wabaScope.target_ids.length > 0) {
          finalWabaId = wabaScope.target_ids[0];
          console.log(`[Meta API] WABA ID extraído con éxito: ${finalWabaId}`);

          const phoneUrl = `https://graph.facebook.com/v20.0/${finalWabaId}/phone_numbers?access_token=${metaAccessToken}`;
          const phoneRes = await fetch(phoneUrl);
          const phoneData: any = await phoneRes.json();

          if (phoneData.data && phoneData.data.length > 0) {
            finalPhoneId = phoneData.data[0].id;
            console.log(`[Meta API] Phone Number ID extraído con éxito: ${finalPhoneId}`);
          } else {
            console.warn(`[Meta API] No se encontraron números de teléfono para el WABA ID ${finalWabaId}`);
          }
        } else {
          console.warn(`[Meta API] No se encontró el WABA ID en los granular_scopes.`);
        }
      } catch (err: any) {
        console.error(`[Meta API] Error al extraer IDs:`, err.message);
      }
    }

    const encryptedMetaToken = await secretsManager.encryptSecret(metaAccessToken);

    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `TENANT#${tenantPhone}`,
        SK: 'METADATA'
      },
      UpdateExpression: "SET encryptedMetaToken = :t, metaWabaId = :w, metaPhoneNumberId = :p",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: {
        ":t": encryptedMetaToken,
        ":w": finalWabaId,
        ":p": finalPhoneId
      }
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: true,
        message: 'Credenciales guardadas y IDs de Meta extraídos exitosamente.',
        metaWabaId: finalWabaId,
        metaPhoneNumberId: finalPhoneId
      })
    };
  } catch (error: any) {
    console.error('Error en api-meta-auth:', error);
    if (error.name === 'ConditionalCheckFailedException') {
      return { statusCode: 404, body: JSON.stringify({ error: 'Tenant no encontrado.' }) };
    }
    return { statusCode: 500, body: JSON.stringify({ error: 'Error interno.' }) };
  }
};
