import axios from 'axios';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Tenant } from './dynamodb';
import { secretsManager } from './secrets-manager';

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION = 'v19.0';

const getHumanDelay = (text: string): number => {
  const baseDelay = 1500 + Math.random() * 1500;
  const charDelay = Math.min(text.length * 15, 3000);
  return Math.round(baseDelay + charDelay);
};

export const whatsapp = {
  sendMessage: async (phoneNumberId: string, to: string, text: string, tenant?: Tenant) => {
    let token = META_ACCESS_TOKEN;
    if (tenant) {
       const tPhone = tenant.PK.replace('TENANT#', '');
       const decrypted = await secretsManager.getDecryptedMetaToken(tPhone, tenant.metaAccessToken, tenant.encryptedMetaToken);
       if (decrypted) token = decrypted;
    }
    if (tenant?.provider === 'EVOLUTION' && tenant.evolutionInstanceName) {
      const delay = getHumanDelay(text);
      try {
        await axios.post(`${process.env.EVOLUTION_API_URL}/chat/sendPresence/${tenant.evolutionInstanceName}`, {
          number: to + '@s.whatsapp.net',
          delay: delay,
          presence: "composing"
        }, { headers: { apikey: process.env.EVOLUTION_API_KEY } });
      } catch(e) { }
      await new Promise(resolve => setTimeout(resolve, delay));
      return axios.post(`${process.env.EVOLUTION_API_URL}/message/sendText/${tenant.evolutionInstanceName}`, {
        number: to,
        text: text
      }, { headers: { apikey: process.env.EVOLUTION_API_KEY } });
    }
    const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;
    return axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  },

  sendTemplate: async (phoneNumberId: string, to: string, templateName: string, languageCode: string = 'es_AR', components?: any[], tenant?: Tenant) => {
    let token = META_ACCESS_TOKEN;
    if (tenant) {
       const tPhone = tenant.PK.replace('TENANT#', '');
       const decrypted = await secretsManager.getDecryptedMetaToken(tPhone, tenant.metaAccessToken, tenant.encryptedMetaToken);
       if (decrypted) token = decrypted;
    }
    const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;

    const templateObj: any = {
      name: templateName,
      language: { code: languageCode },
    };

    if (components && components.length > 0) {
      templateObj.components = components;
    }

    return axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: templateObj
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  },

    getMediaUrl: async (mediaId: string, tenant?: any) => {
    let token = META_ACCESS_TOKEN;
    if (tenant && tenant.encryptedMetaToken) {
        const { secretsManager } = require('./secrets-manager');
        try {
            token = await secretsManager.getDecryptedMetaToken(tenant.PK, undefined, tenant.encryptedMetaToken) || token;
        } catch(e) {}
    }
    const url = `https://graph.facebook.com/${API_VERSION}/${mediaId}`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    return response.data.url;
  },

  downloadEvolutionMedia: async (instanceName: string, messageObj: any): Promise<Buffer> => {
    const url = `${process.env.EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${instanceName}`;
    const response = await axios.post(url, { message: messageObj }, {
      headers: {
        'apikey': process.env.EVOLUTION_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    return Buffer.from(response.data.base64, 'base64');
  },
  downloadMedia: async (mediaUrl: string, tenant?: any): Promise<Uint8Array> => {
    let token = META_ACCESS_TOKEN;
    if (tenant && tenant.encryptedMetaToken) {
        const { secretsManager } = require('./secrets-manager');
        try {
            token = await secretsManager.getDecryptedMetaToken(tenant.PK, undefined, tenant.encryptedMetaToken) || token;
        } catch(e) {
            console.error("Error decrypting token for downloadMedia:", e);
        }
    }
    const response = await axios.get(mediaUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'curl/7.68.0'
      },
      responseType: 'arraybuffer',
    });
    return new Uint8Array(response.data);
  },

  uploadMediaToWhatsApp: async (phoneNumberId: string, buffer: Buffer, filename: string): Promise<string> => {
    const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/media`;

    const tmpPath = path.join(os.tmpdir(), `${Date.now()}_${filename}`);
    fs.writeFileSync(tmpPath, buffer);

    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('file', fs.createReadStream(tmpPath), {
      filename,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });

    try {
      const response = await axios.post(url, formData, {
        headers: {
          Authorization: `Bearer ${META_ACCESS_TOKEN}`,
          ...formData.getHeaders()
        }
      });
      try { fs.unlinkSync(tmpPath); } catch(e){}
      return response.data.id;
    } catch (e: any) {
      try { fs.unlinkSync(tmpPath); } catch(err){}
      console.error('Error uploading media to Meta:', e?.response?.data || e.message);
      throw e;
    }
  },

  sendDocumentEvolution: async (instanceName: string, to: string, buffer: Buffer, filename: string, caption?: string) => {
    const base64Media = buffer.toString('base64');
    return axios.post(`${process.env.EVOLUTION_API_URL}/message/sendMedia/${instanceName}`, {
      number: to,
      mediatype: 'document',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      caption: caption || '',
      media: base64Media,
      fileName: filename
    }, { headers: { apikey: process.env.EVOLUTION_API_KEY } });
  },

  sendDocumentMessage: async (phoneNumberId: string, to: string, mediaId: string, filename: string, caption?: string) => {
    const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;
    try {
      return await axios.post(
        url,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'document',
          document: {
            id: mediaId,
            filename,
            caption
          },
        },
        {
          headers: {
            Authorization: `Bearer ${META_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (e: any) {
      console.error('Error sending document via Meta:', e?.response?.data || e.message);
      throw e;
    }
  },
};
