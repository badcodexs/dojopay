import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const mode = event.queryStringParameters?.['hub.mode'];
    const token = event.queryStringParameters?.['hub.verify_token'];
    const challenge = event.queryStringParameters?.['hub.challenge'];

    if (!mode || !token) {
      return { statusCode: 400, body: 'Bad Request: Missing hub parameters' };
    }

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified successfully!');
      return {
        statusCode: 200,
        body: challenge || '',
      };
    } else {
      console.warn('Failed webhook verification: Token mismatch.');
      return { statusCode: 403, body: 'Forbidden: Invalid verify_token' };
    }
  } catch (error: any) {
    console.error('CRITICAL Error verifying webhook:', error);
    return { statusCode: 500, body: `Internal Server Error: ${error.message}` };
  }
};
