import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import * as crypto from 'crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const APP_SECRET = process.env.META_APP_SECRET || '';
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL || '';
const sqs = new SQSClient({ region: 'us-east-1' });

function verifyMetaSignature(payload: string, signatureHeader: string): boolean {
  if (!APP_SECRET) return true;
  const expectedSignature = crypto
    .createHmac('sha256', APP_SECRET)
    .update(payload)
    .digest('hex');
  return signatureHeader === `sha256=${expectedSignature}`;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    let rawBody = event.body || '{}';
    if (event.isBase64Encoded) {
      rawBody = Buffer.from(rawBody, 'base64').toString('utf-8');
    }

    let body: any = {};
    try {
      body = JSON.parse(rawBody);
    } catch(e) {}

    const signature = event.headers['X-Hub-Signature-256'] || event.headers['x-hub-signature-256'];
    if (body.object === 'whatsapp_business_account' && signature && !verifyMetaSignature(rawBody, signature)) {
      console.error('Invalid signature detected');
      return { statusCode: 401, body: 'Unauthorized' };
    }

    if (!Object.keys(body).length) { return { statusCode: 400, body: `Bad Request: Invalid JSON format` }; }

    if (body.object !== 'whatsapp_business_account' && !body.event) {
      return { statusCode: 404, body: 'Not Found' };
    }

    if (SQS_QUEUE_URL) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        MessageBody: rawBody,
      }));
      console.log('Message pushed to SQS successfully.');
    } else {
      console.error('SQS_QUEUE_URL not defined');
    }

    return { statusCode: 200, body: 'OK' };
  } catch (error: any) {
    console.error('CRITICAL Error processing webhook:', error);
    return { statusCode: 500, body: `Internal Server Error: ${error.message}` };
  }
};
