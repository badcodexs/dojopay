import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { dynamo, TenantConfig } from '../services/dynamodb';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];
    const expectedApiKey = process.env.DOJOPAY_API_KEY;

    if (!apiKey || apiKey !== expectedApiKey) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized: Invalid or missing API Key' }),
      };
    }

    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Bad Request: Missing request body' }),
      };
    }

    let rawBody = event.body;
    if (event.isBase64Encoded) {
      rawBody = Buffer.from(rawBody, 'base64').toString('utf-8');
    }

    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch (parseError: any) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Bad Request: Invalid JSON format', details: parseError.message }),
      };
    }

    const { tenantPhone, config } = parsedBody;

    if (!tenantPhone || !config) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Bad Request: Missing tenantPhone or config in JSON payload' }),
      };
    }

    const tenant = await dynamo.getTenant(tenantPhone);
    if (!tenant) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: `Not Found: Tenant ${tenantPhone} does not exist in DynamoDB` }),
      };
    }

    const typedConfig = config as TenantConfig;
    await dynamo.updateTenantConfig(tenantPhone, typedConfig);

    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Success: Config for tenant ${tenantPhone} updated correctly` }),
    };
  } catch (error) {
    console.error('CRITICAL Error in configTenant handler:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error processing the config injection' }),
    };
  }
};
