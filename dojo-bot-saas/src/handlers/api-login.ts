import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';

const ssmClient = new SSMClient({});
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const TABLE_NAME = process.env.DYNAMODB_TABLE!;

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

  if (!response.Parameter?.Value) {
    throw new Error('JWT_SECRET no encontrado en SSM');
  }

  cachedJwtSecret = response.Parameter.Value;
  lastCacheTime = now;
  return cachedJwtSecret;
};

export const handler = async (event: any): Promise<any> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { phone, password } = body;

    if (!phone || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Faltan credenciales.' })
      };
    }

    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `TENANT#${phone}`,
        SK: 'METADATA'
      }
    }));

    const tenant = result.Item;

    if (!tenant || !tenant.passwordHash) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Credenciales inválidas.' })
      };
    }

    const isMatch = await bcrypt.compare(password, tenant.passwordHash);
    if (!isMatch) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Credenciales inválidas.' })
      };
    }

    const secret = await getJwtSecret();
    const token = jwt.sign(
      { phone: tenant.PK.replace('TENANT#', ''), role: 'TENANT' },
      secret,
      { expiresIn: '24h' }
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        token,
        businessName: tenant.businessName,
        phone: tenant.PK.replace('TENANT#', ''),
        isConnected: !!tenant.metaPhoneNumberId || !!tenant.encryptedMetaToken
      })
    };
  } catch (error) {
    console.error('Error en login:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error interno del servidor.' })
    };
  }
};
