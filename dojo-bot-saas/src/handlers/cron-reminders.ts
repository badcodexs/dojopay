import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { whatsapp } from '../services/whatsapp';
import { Student, dynamo, Tenant } from '../services/dynamodb';
import { CrossHeroScraper } from '../services/crosshero-scraper';
import { secretsManager } from '../services/secrets-manager';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.DYNAMODB_TABLE!;

export const handler = async (event: any): Promise<void> => {
  console.log('Iniciando Cron Job de Recordatorios y Sincronización...');

  try {
    const tenantCmd = new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'ActiveTenantsIndex',
      KeyConditionExpression: "cronStatus = :status",
      ExpressionAttributeValues: { ":status": "ACTIVE" }
    });
    const tenantRes = await docClient.send(tenantCmd);
    const tenants = ((tenantRes.Items || []) as Tenant[]).filter(t => t.PK.startsWith('TENANT#'));

    for (const tenant of tenants) {
      if (tenant.crossHeroConfig?.enabled) {
        const tenantPhone = tenant.PK.replace('TENANT#', '');
        console.log(`Sincronizando CrossHero (Pull) para el tenant ${tenantPhone}...`);

        let billingData: any[] = [];
        const { adminEmail, adminPass, adminPassEncrypted } = tenant.crossHeroConfig;

        if (adminEmail && (adminPass || adminPassEncrypted)) {
          try {
            const password = await secretsManager.getDecryptedSecret(tenantPhone, adminPass, adminPassEncrypted);
            if (!password) {
              throw new Error("No se pudo descifrar la contraseña de CrossHero");
            }
            const scraper = new CrossHeroScraper(tenantPhone, adminEmail, password);
            billingData = await scraper.getBillingData();
            console.log(`[Scraper] Se obtuvieron datos de facturación para ${billingData.length} alumnos.`);
          } catch (e) {
            console.error(`[Scraper] Error al obtener datos de facturación para ${tenantPhone}:`, e);
          }
        }

        const students = await dynamo.getStudentsByTenant(tenantPhone);
        for (const localStudent of students) {
          const phone = localStudent.SK.replace('STUDENT#', '');
          const localName = localStudent.name.toLowerCase().trim();

          const billing = billingData.find(b => {
            const bName = b.name.replace(/\n.*/g, '').toLowerCase().trim();
            return bName === localName || localName.includes(bName) || bName.includes(localName);
          });

          if (billing) {
            let paidUntilDate: string | undefined;
            let paymentDay: number | undefined;
            const chStatus = 'ACTIVE';

            if (billing.dueDateStr) {
              const parts = billing.dueDateStr.split('/');
              if (parts.length === 3) {
                const [day, month, year] = parts;
                paidUntilDate = new Date(`${year}-${month}-${day}T12:00:00Z`).toISOString();
                paymentDay = parseInt(day, 10);
              }
            }

            const updates: string[] = [];
            const exprValues: any = {};

            if (paidUntilDate && localStudent.paidUntilDate !== paidUntilDate) {
              updates.push("paidUntilDate = :p");
              exprValues[":p"] = paidUntilDate;
              updates.push("paymentDay = :d");
              exprValues[":d"] = paymentDay;
            }
            if (billing.planPrice !== undefined && localStudent.planPrice !== billing.planPrice) {
              updates.push("planPrice = :pp");
              exprValues[":pp"] = billing.planPrice;
            }
            if (billing.id && localStudent.crossHeroId !== billing.id) {
              updates.push("crossHeroId = :chId");
              exprValues[":chId"] = billing.id;
            }
            if (chStatus && localStudent.status !== chStatus) {
              updates.push("#st = :st");
              exprValues[":st"] = chStatus;
            }

            if (updates.length > 0) {
               const cmd: any = {
                 TableName: TABLE_NAME,
                 Key: { PK: `TENANT#${tenantPhone}`, SK: `STUDENT#${phone}` },
                 UpdateExpression: "SET " + updates.join(", "),
                 ExpressionAttributeValues: exprValues
               };
               if (updates.some(u => u.includes("#st"))) {
                 cmd.ExpressionAttributeNames = { "#st": "status" };
               }
               await docClient.send(new UpdateCommand(cmd));
            }
          } else {
             if (localStudent.status === 'ACTIVE') {
                 await docClient.send(new UpdateCommand({
                   TableName: TABLE_NAME,
                   Key: { PK: `TENANT#${tenantPhone}`, SK: `STUDENT#${phone}` },
                   UpdateExpression: "SET #st = :st",
                   ExpressionAttributeNames: { "#st": "status" },
                   ExpressionAttributeValues: { ":st": "INACTIVE" }
                 }));
                 console.log(`Atleta inactivo en CrossHero, desactivado en DojoPay: ${localStudent.name}`);
             }
          }
        }
      }
    }

    let students: Student[] = [];
    for (const t of tenants) {
      const tPhone = t.PK.replace('TENANT#', '');
      const tStudents = await dynamo.getStudentsByTenant(tPhone);
      students = students.concat(tStudents);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let processed = 0;
    let failed = 0;
    const tenantCache: Record<string, any> = {};

    tenants.forEach(t => {
      tenantCache[t.PK.replace('TENANT#', '')] = {
        phoneNumberId: t.metaPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || 'default_phone_id',
        templateName: t.metaTemplateName || 'recordatorio_pago_mensual',
        businessName: t.businessName || 'la academia'
      };
      console.log('DEBUG Tenant:', t.PK, 'phoneNumberId:', t.metaPhoneNumberId, 'template:', t.metaTemplateName);
    });

    for (const student of students) {
      if (!student.paidUntilDate) continue;

      const paidUntil = new Date(student.paidUntilDate);
      paidUntil.setHours(0, 0, 0, 0);

      if (today > paidUntil) {
        const msOverdue = today.getTime() - paidUntil.getTime();
        const daysOverdue = Math.floor(msOverdue / (1000 * 60 * 60 * 24));

        const tenantPhone = student.PK.replace('TENANT#', '');
        const tenantData = tenantCache[tenantPhone];
        if (!tenantData) continue;

        let templateName = '';
        if (daysOverdue === 1) {
            templateName = tenantData.templateName;
        }

        if (templateName) {
          const studentPhone = student.SK.replace('STUDENT#', '');
          try {
            if (tenantData.provider === 'EVOLUTION') {
              const textMsg = `Hola ${student.name}, te escribimos de ${tenantData.businessName} para recordarte que tu mensualidad ha vencido. ¡Por favor ponte al día para seguir entrenando!`;
              await whatsapp.sendMessage(tenantData.phoneNumberId, studentPhone, textMsg, tenantData);
            } else {
              const components = (templateName !== 'recordatorio_pago_simple' && templateName !== 'recordatorio_simple') ? [
                {
                  type: 'body',
                  parameters: [
                    { type: 'text', text: student.name },
                    { type: 'text', text: tenantData.businessName }
                  ]
                }
              ] : undefined;
              await whatsapp.sendTemplate(tenantData.phoneNumberId, studentPhone, templateName, 'es_AR', components);
            }
            processed++;
          } catch (error) {
            console.error(`Fallo al enviar recordatorio a ${studentPhone}:`, error);
            failed++;
          }
        }
      }
    }

    console.log(`Cron Job Finalizado. Exitosos: ${processed}, Fallidos: ${failed}.`);
  } catch (error) {
    console.error('Error crítico ejecutando el Cron Job:', error);
    throw error;
  }
};
