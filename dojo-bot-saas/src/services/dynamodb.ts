import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, ScanCommand, TransactWriteCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const client = new DynamoDBClient({
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 2000,
    requestTimeout: 3000
  }),
  maxAttempts: 3
});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.DYNAMODB_TABLE!;

export interface AcademiaConfig {
  nombre: string;
  disciplina: string;
  profesor_principal: string;
  direccion: string;
  telefono_administrador: string;
}

export interface DatosBancariosConfig {
  banco: string;
  tipo_cuenta: string;
  numero_cuenta: string;
  rut: string;
  nombre_titular: string;
  correo_comprobantes: string;
}

export interface PlanPrecioConfig {
  nombre_plan: string;
  valor_mensual: number;
  frecuencia_semanal: string;
}

export interface HorarioClaseConfig {
  dia: string;
  hora_inicio: string;
  hora_fin: string;
  disciplina: string;
}

export interface ReglaFrecuenteConfig {
  pregunta_o_tema: string;
  respuesta_oficial: string;
}

export interface TenantConfig {
  academia: AcademiaConfig;
  datos_bancarios: DatosBancariosConfig;
  planes_y_precios: PlanPrecioConfig[];
  horarios_clases: HorarioClaseConfig[];
  reglas_frecuentes: ReglaFrecuenteConfig[];
  politica_clase_prueba: string;
}

/**
 * Single-table design. Key patterns:
 *   TENANT#<tenantPhone> | METADATA                          -> Tenant
 *   TENANT#<tenantPhone> | STUDENT#<phone>                   -> Student
 *   TENANT#<tenantPhone> | COACH#<phone>                     -> Coach
 *   TENANT#<tenantPhone> | PAYMENT#<isoDate>#STUDENT#<phone> -> Payment
 *   TENANT#<tenantPhone> | CONVERSATION#<phone>              -> LLM history (10 min TTL)
 *   TENANT#<tenantPhone> | PENDING#<phone>                   -> debounce buffer
 *   MESSAGE#<messageId>  | METADATA                         -> webhook idempotency marker
 */
export interface Tenant {
  PK: string;
  SK: string;
  status?: 'ACTIVE' | 'INACTIVE';
  cronStatus?: string;
  businessName: string;
  industry: string;
  monthlyFee: number;
  personaConfig: string;
  passwordHash?: string;
  encryptedMetaToken?: string;
  metaAccessToken?: string;
  adminPhone?: string;
  adminPhones?: string[];
  metaPhoneNumberId?: string;
  metaTemplateName?: string;
  provider?: 'META' | 'EVOLUTION';
  evolutionInstanceName?: string;
  config?: TenantConfig;
  crossHeroConfig?: {
    boxId: string;
    accessToken: string;
    enabled: boolean;
    sessionCookie?: string;
    adminEmail?: string;
    adminPass?: string;
    adminPassEncrypted?: string;
  };
  googleSheetsConfig?: {
    enabled: boolean;
    maxAdvanceBookingDays: number;
    spreadsheetIds: {
      vina: string;
      curauma: string;
    };
  };
  aiConfig?: {
    customPromptVersion?: string;
    customSystemPrompt?: string;
    allowedTools?: string[];
  };
  pausedChats?: string[];
}

export interface Coach {
  PK: string;
  SK: string;
  name: string;
  alias?: string;
  phone?: string;
  createdAt?: string;
  status?: string;
}

export interface Student {
  PK: string;
  SK: string;
  name: string;
  crossHeroId?: string;
  status: 'ACTIVE' | 'INACTIVE' | 'FROZEN';
  paymentDay: number;
  planPrice: number;
  createdAt: string;
  paidUntilDate?: string;
  assignedCoach?: string;
  assignedCoaches?: string[];
}

export interface Payment {
  PK: string;
  SK: string;
  studentName: string;
  studentPhone: string;
  amount: number;
  calculatedMonths: number;
  method: 'CASH' | 'TRANSFER';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVERTED';
  receiptUrl?: string;
  createdAt: string;
}

import { secretsManager } from './secrets-manager';

export const dynamo = {
  getTenant: async (tenantPhone: string): Promise<Tenant | null> => {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: 'METADATA' }
    }));
    return (result.Item as Tenant) || null;
  },

  updateTenantConfig: async (tenantPhone: string, config: TenantConfig): Promise<void> => {
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: 'METADATA' },
      UpdateExpression: "SET config = :config, cronStatus = :cronStatus",
      ExpressionAttributeValues: {
        ":config": config,
        ":cronStatus": "ACTIVE"
      }
    }));
  },

  updateTenantCrossHeroConfig: async (tenantPhone: string, config: any): Promise<void> => {
    const safeConfig = { ...config };
    if (safeConfig.adminPass) {
      safeConfig.adminPassEncrypted = await secretsManager.encryptSecret(safeConfig.adminPass);
      delete safeConfig.adminPass;
    }

    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: 'METADATA' },
      UpdateExpression: "SET crossHeroConfig = :config, cronStatus = :cronStatus",
      ExpressionAttributeValues: {
        ":config": safeConfig,
        ":cronStatus": "ACTIVE"
      }
    }));
  },

  setChatPauseState: async (tenantPhone: string, chatPhone: string, pause: boolean): Promise<void> => {
    const tenant = await dynamo.getTenant(tenantPhone);
    if (!tenant) return;

    let pausedChats = tenant.pausedChats || [];
    if (pause) {
      if (!pausedChats.includes(chatPhone)) pausedChats.push(chatPhone);
    } else {
      pausedChats = pausedChats.filter(p => p !== chatPhone);
    }

    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: 'METADATA' },
      UpdateExpression: "SET pausedChats = :pc",
      ExpressionAttributeValues: {
        ":pc": pausedChats
      }
    }));
  },

  getCoach: async (tenantPhone: string, coachPhone: string): Promise<Coach | null> => {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: `COACH#${coachPhone}` }
    }));
    return (result.Item as Coach) || null;
  },

  createCoach: async (tenantPhone: string, coachPhone: string, name: string): Promise<void> => {
    const now = new Date().toISOString();
    const coach: Coach = {
      PK: `TENANT#${tenantPhone}`,
      SK: `COACH#${coachPhone}`,
      name,
      phone: coachPhone,
      createdAt: now,
      status: 'ACTIVE'
    };
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: coach
    }));
  },

  getCoachesByTenant: async (tenantPhone: string): Promise<Coach[]> => {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
      ExpressionAttributeValues: {
        ":pk": `TENANT#${tenantPhone}`,
        ":skPrefix": "COACH#"
      }
    }));
    return (result.Items as Coach[]) || [];
  },

  assignCoachToStudent: async (tenantPhone: string, studentPhone: string, coachPhone: string): Promise<void> => {
    const student = await dynamo.getStudent(tenantPhone, studentPhone);
    if (!student) return;
    const currentCoaches = student.assignedCoaches || [];
    const coachKey = `COACH#${coachPhone}`;
    if (currentCoaches.includes(coachKey)) return;

    const newCoaches = [...currentCoaches, coachKey];
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: `STUDENT#${studentPhone}` },
      UpdateExpression: "SET assignedCoaches = :coaches",
      ExpressionAttributeValues: {
        ":coaches": newCoaches
      }
    }));
  },

  removeCoachFromStudent: async (tenantPhone: string, studentPhone: string, coachPhone: string): Promise<void> => {
    const student = await dynamo.getStudent(tenantPhone, studentPhone);
    if (!student) return;
    const currentCoaches = student.assignedCoaches || [];
    const coachKey = `COACH#${coachPhone}`;
    if (!currentCoaches.includes(coachKey)) return;

    const newCoaches = currentCoaches.filter(c => c !== coachKey);
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: `STUDENT#${studentPhone}` },
      UpdateExpression: "SET assignedCoaches = :coaches",
      ExpressionAttributeValues: {
        ":coaches": newCoaches
      }
    }));
  },

  getStudent: async (tenantPhone: string, studentPhone: string): Promise<Student | null> => {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: `STUDENT#${studentPhone}` }
    }));
    return (result.Item as Student) || null;
  },

  checkStudentStatusByName: async (tenantPhone: string, studentName: string): Promise<string> => {
    try {
      const students = await dynamo.findStudentsByName(tenantPhone, studentName);

      if (!students || students.length === 0) {
        return `No se encontró ningún alumno con el nombre o fragmento "${studentName}".`;
      }

      let response = `Se encontraron ${students.length} alumnos que coinciden:\n`;
      const today = new Date();
      for (const student of students) {
        const phone = student.SK.split('#')[1] || '';
        if (student.paidUntilDate) {
           const paidUntil = new Date(student.paidUntilDate);
           let daysOverdue = 0;
           if (today > paidUntil) {
               daysOverdue = Math.floor((today.getTime() - paidUntil.getTime()) / (1000 * 60 * 60 * 24));
           }
           response += `- ${student.name} (Tel: ${phone}): Cuenta ${student.status === 'ACTIVE' ? 'Inscrita' : student.status}, Día de pago: ${student.paymentDay}, Valor del Plan: $${student.planPrice}, Pagado hasta: ${student.paidUntilDate}, Días de deuda: ${daysOverdue}\n`;
        } else {
           response += `- ${student.name} (Tel: ${phone}): Cuenta ${student.status === 'ACTIVE' ? 'Inscrita' : student.status}, Día de pago: ${student.paymentDay}, Valor del Plan: $${student.planPrice}, Pagado hasta: NUNCA HA PAGADO, Días de deuda: PENDIENTE DE PAGO INICIAL\n`;
        }
      }
      return response;
    } catch (e) {
      console.error("Error buscando alumno por nombre:", e);
      return "Hubo un error técnico al buscar en la base de datos.";
    }
  },

  findStudentsByName: async (tenantPhone: string, studentName: string): Promise<Student[]> => {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
      ExpressionAttributeValues: {
        ":pk": `TENANT#${tenantPhone}`,
        ":skPrefix": "STUDENT#"
      }
    }));

    const students = (result.Items || []) as Student[];
    const normalize = (str: string) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const searchNormalized = normalize(studentName);

    return students.filter(s => normalize(s.name).includes(searchNormalized));
  },

  getStudentsByTenant: async (tenantPhone: string, filter?: 'ALL' | 'ACTIVE' | 'INACTIVE' | 'DEBTORS' | 'UP_TO_DATE' | 'DUE_SOON', coachPhone?: string): Promise<Student[]> => {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
      ExpressionAttributeValues: {
        ":pk": `TENANT#${tenantPhone}`,
        ":skPrefix": "STUDENT#"
      }
    }));

    let students = (result.Items || []) as Student[];

    if (coachPhone) {
      students = students.filter(s => s.assignedCoaches?.includes(`COACH#${coachPhone}`) || s.assignedCoach === `COACH#${coachPhone}`);
    }

    if (filter === 'ACTIVE') {
      return students.filter(s => s.status === 'ACTIVE');
    }

    if (filter === 'INACTIVE') {
      return students.filter(s => s.status === 'INACTIVE');
    }

    if (filter === 'DEBTORS' || filter === 'UP_TO_DATE' || filter === 'DUE_SOON') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);

      students = students.filter(s => {
        if (s.status !== 'ACTIVE') return false;

        if (filter === 'DEBTORS') {
          if (!s.paidUntilDate) return true;
          const paidUntil = new Date(s.paidUntilDate);
          paidUntil.setHours(0, 0, 0, 0);
          return paidUntil < today;
        }

        if (filter === 'UP_TO_DATE') {
          if (!s.paidUntilDate) return false;
          const paidUntil = new Date(s.paidUntilDate);
          paidUntil.setHours(0, 0, 0, 0);
          return paidUntil > tomorrow;
        }

        if (filter === 'DUE_SOON') {
          if (!s.paidUntilDate) return false;
          const paidUntil = new Date(s.paidUntilDate);
          paidUntil.setHours(0, 0, 0, 0);
          return paidUntil.getTime() === today.getTime() || paidUntil.getTime() === tomorrow.getTime();
        }

        return true;
      });
    }

    return students;
  },

  createPayment: async (payment: Payment): Promise<void> => {
      await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: payment
      }));
  },

  getPendingPaymentForStudent: async (tenantPhone: string, studentPhone: string): Promise<Payment | null> => {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
      FilterExpression: "studentPhone = :phone AND #status = :status",
      ExpressionAttributeNames: {
        "#status": "status"
      },
      ExpressionAttributeValues: {
        ":pk": `TENANT#${tenantPhone}`,
        ":skPrefix": "PAYMENT#",
        ":phone": studentPhone,
        ":status": "PENDING"
      }
    }));

    if (!result.Items || result.Items.length === 0) return null;

    const sorted = result.Items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sorted[0] as Payment;
  },

  revertLastPayment: async (tenantPhone: string, studentPhone: string): Promise<Payment | null> => {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
      FilterExpression: "studentPhone = :phone AND #status = :status",
      ExpressionAttributeNames: {
        "#status": "status"
      },
      ExpressionAttributeValues: {
        ":pk": `TENANT#${tenantPhone}`,
        ":skPrefix": "PAYMENT#",
        ":phone": studentPhone,
        ":status": "APPROVED"
      }
    }));

    if (!result.Items || result.Items.length === 0) return null;

    const sorted = result.Items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const lastPayment = sorted[0] as Payment;

    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: lastPayment.SK },
      UpdateExpression: "SET #status = :status",
      ExpressionAttributeNames: {
        "#status": "status"
      },
      ExpressionAttributeValues: {
        ":status": "REVERTED"
      }
    }));

    const student = await dynamo.getStudent(tenantPhone, studentPhone);
    if (student) {
      await dynamo.advancePaidUntilDate(tenantPhone, studentPhone, -lastPayment.amount, student.planPrice, student.paymentDay);
    }

    return lastPayment;
  },

  updatePaymentStatus: async (tenantPhone: string, paymentSK: string, newStatus: 'APPROVED' | 'REJECTED' | 'REVERTED'): Promise<void> => {
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: paymentSK },
      UpdateExpression: "SET #status = :status",
      ExpressionAttributeNames: {
        "#status": "status"
      },
      ExpressionAttributeValues: {
        ":status": newStatus
      }
    }));
  },

  advancePaidUntilDate: async (tenantPhone: string, studentPhone: string, amountPaid: number, planPrice: number, paymentDay: number, forceResetDate?: Date): Promise<void> => {
    const { calculateNextDueDate } = require('../utils/finance');
    const MAX_RETRIES = 3;

    for (let i = 0; i < MAX_RETRIES; i++) {
      const student = await dynamo.getStudent(tenantPhone, studentPhone);
      if (!student) return;

      let baseDateStr = new Date().toISOString();
      if (student.paidUntilDate) {
        baseDateStr = student.paidUntilDate;
      }

      const newDateStr = calculateNextDueDate(baseDateStr, paymentDay, amountPaid, planPrice, forceResetDate);

      try {
        await docClient.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: `TENANT#${tenantPhone}`, SK: `STUDENT#${studentPhone}` },
          UpdateExpression: "SET paidUntilDate = :newDate",
          ConditionExpression: student.paidUntilDate ? "paidUntilDate = :oldDate" : "attribute_not_exists(paidUntilDate)",
          ExpressionAttributeValues: student.paidUntilDate ? {
            ":newDate": newDateStr,
            ":oldDate": student.paidUntilDate
          } : {
            ":newDate": newDateStr
          }
        }));
        return;
      } catch (error: any) {
        if (error.name === 'ConditionalCheckFailedException') {
          console.log(`Race condition detected for student ${studentPhone}, retrying (${i + 1}/${MAX_RETRIES})...`);
          continue;
        }
        throw error;
      }
    }
    console.error(`Failed to update paidUntilDate for ${studentPhone} after ${MAX_RETRIES} retries due to race conditions.`);
  },

  updateStudentStatus: async (tenantPhone: string, studentName: string, newStatus: 'ACTIVE' | 'INACTIVE' | 'FROZEN'): Promise<boolean> => {
    const students = await dynamo.findStudentsByName(tenantPhone, studentName);
    if (students.length === 0) return false;

    const student = students[0];
    const phoneParts = student.SK.split('#');
    const studentPhone = phoneParts.length > 1 ? phoneParts[1] : student.SK;

    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: `STUDENT#${studentPhone}` },
      UpdateExpression: "SET #status = :status",
      ExpressionAttributeNames: {
        "#status": "status"
      },
      ExpressionAttributeValues: {
        ":status": newStatus
      }
    }));
    return true;
  },

  migrateStudentPhone: async (tenantPhone: string, oldPhone: string, newPhone: string): Promise<boolean> => {
    const student = await dynamo.getStudent(tenantPhone, oldPhone);
    if (!student) {
      return false;
    }

    const newStudent = { ...student };
    newStudent.SK = `STUDENT#${newPhone}`;
    if ((newStudent as any).telefono) {
      (newStudent as any).telefono = newPhone;
    }

    await docClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: newStudent
          }
        },
        {
          Delete: {
            TableName: TABLE_NAME,
            Key: { PK: `TENANT#${tenantPhone}`, SK: `STUDENT#${oldPhone}` }
          }
        }
      ]
    }));

    return true;
  },

  deleteStudent: async (tenantPhone: string, studentPhone: string): Promise<boolean> => {
    try {
      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantPhone}`, SK: `STUDENT#${studentPhone}` }
      }));
      return true;
    } catch (e) {
      console.error("Error al eliminar alumno:", e);
      return false;
    }
  },

  updateStudentNameByPhone: async (tenantPhone: string, studentPhone: string, newName: string): Promise<void> => {
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: `STUDENT#${studentPhone}` },
      UpdateExpression: "SET #name = :name",
      ExpressionAttributeNames: {
        "#name": "name"
      },
      ExpressionAttributeValues: {
        ":name": newName
      }
    }));
  },

  updateStudentStatusByPhone: async (tenantPhone: string, studentPhone: string, newStatus: 'ACTIVE' | 'INACTIVE' | 'FROZEN'): Promise<void> => {
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: `STUDENT#${studentPhone}` },
      UpdateExpression: "SET #status = :status",
      ExpressionAttributeNames: {
        "#status": "status"
      },
      ExpressionAttributeValues: {
        ":status": newStatus
      }
    }));
  },

  updateStudentData: async (tenantPhone: string, studentName: string, updates: { planPrice?: number, paymentDay?: number, name?: string }): Promise<boolean> => {
    const students = await dynamo.findStudentsByName(tenantPhone, studentName);
    if (students.length === 0) return false;

    const student = students[0];
    const phoneParts = student.SK.split('#');
    const studentPhone = phoneParts.length > 1 ? phoneParts[1] : student.SK;

    let updateExpression = "SET";
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    let hasUpdates = false;

    if (updates.name !== undefined) {
      updateExpression += " #name = :name,";
      expressionAttributeNames["#name"] = "name";
      expressionAttributeValues[":name"] = updates.name;
      hasUpdates = true;
    }
    if (updates.planPrice !== undefined) {
      updateExpression += " planPrice = :planPrice,";
      expressionAttributeValues[":planPrice"] = updates.planPrice;
      hasUpdates = true;
    }
    if (updates.paymentDay !== undefined) {
      updateExpression += " paymentDay = :paymentDay,";
      expressionAttributeValues[":paymentDay"] = updates.paymentDay;
      hasUpdates = true;
    }

    if (!hasUpdates) return true;

    updateExpression = updateExpression.slice(0, -1);

    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TENANT#${tenantPhone}`, SK: `STUDENT#${studentPhone}` },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
      ExpressionAttributeValues: expressionAttributeValues
    }));
    return true;
  },

  createStudentFromChat: async (tenantPhone: string, data: { name: string, phone: string, planPrice: number, paymentDay: number, hasPaidInitial: boolean }): Promise<void> => {
    const formattedPhone = data.phone.replace(/[\+\s\-]/g, '');

    const newStudent: Student = {
      PK: `TENANT#${tenantPhone}`,
      SK: `STUDENT#${formattedPhone}`,
      name: data.name,
      status: 'ACTIVE',
      planPrice: data.planPrice,
      paymentDay: data.paymentDay,
      createdAt: new Date().toISOString()
    };

    if (data.hasPaidInitial) {
      newStudent.paidUntilDate = new Date().toISOString();
    }

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: newStudent
    }));
  },

  hasMessageBeenProcessed: async (messageId: string): Promise<boolean> => {
    try {
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `MESSAGE#${messageId}`, SK: 'METADATA' }
      }));
      return !!result.Item;
    } catch (e) {
      return false;
    }
  },

  saveMessageId: async (messageId: string): Promise<void> => {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `MESSAGE#${messageId}`,
        SK: 'METADATA',
        createdAt: Date.now()
      }
    }));
  },

  addPendingMessage: async (tenantPhone: string, userPhone: string, text: string): Promise<number> => {
    try {
      const response = await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantPhone}`, SK: `PENDING#${userPhone}` },
        UpdateExpression: "SET messages = list_append(if_not_exists(messages, :empty_list), :new_msg)",
        ExpressionAttributeValues: {
          ":empty_list": [],
          ":new_msg": [text]
        },
        ReturnValues: "UPDATED_NEW"
      }));
      return response.Attributes?.messages?.length || 1;
    } catch (e) {
      console.error('Error adding pending message:', e);
      return 1;
    }
  },

  getPendingMessagesCount: async (tenantPhone: string, userPhone: string): Promise<number> => {
    try {
      const response = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantPhone}`, SK: `PENDING#${userPhone}` }
      }));
      return response.Item?.messages?.length || 0;
    } catch (e) {
      return 0;
    }
  },

  clearAndGetPendingMessages: async (tenantPhone: string, userPhone: string): Promise<string[]> => {
    try {
      const response = await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantPhone}`, SK: `PENDING#${userPhone}` },
        ReturnValues: "ALL_OLD"
      }));
      return response.Attributes?.messages || [];
    } catch (e) {
      return [];
    }
  },

  getConversationHistory: async (tenantPhone: string, userPhone: string): Promise<any[]> => {
    try {
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantPhone}`, SK: `CONVERSATION#${userPhone}` }
      }));

      const item = result.Item;
      if (!item) return [];

      // Conversations go stale after 10 minutes so the agent starts with a clean context.
      const tenMinutesAgo = Date.now() - 600000;
      if (item.updatedAt < tenMinutesAgo) {
        return [];
      }

      return item.messages || [];
    } catch (e) {
      return [];
    }
  },

  getFullConversationHistory: async (tenantPhone: string, userPhone: string): Promise<any[]> => {
    try {
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantPhone}`, SK: `CONVERSATION#${userPhone}` }
      }));

      const item = result.Item;
      if (!item) return [];

      return item.messages || [];
    } catch (e) {
      return [];
    }
  },

  getRecentConversations: async (tenantPhone: string, limitHours = 24): Promise<{phone: string, lastMessageAt: Date, messages: any[]}[]> => {
    try {
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `TENANT#${tenantPhone}`,
          ":skPrefix": "CONVERSATION#"
        }
      }));

      const items = result.Items || [];
      const threshold = Date.now() - (limitHours * 60 * 60 * 1000);

      return items
        .filter(item => item.updatedAt >= threshold)
        .map(item => ({
          phone: item.SK.replace('CONVERSATION#', ''),
          lastMessageAt: new Date(item.updatedAt),
          messages: item.messages || []
        }))
        .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
    } catch (e) {
      console.error(e);
      return [];
    }
  },

  getFinancialMetrics: async (tenantPhone: string, yearMonth: string): Promise<{ totalRecaudado: number, mensualidadesPagadas: number, deudaPendiente: number }> => {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
      FilterExpression: "#status = :status",
      ExpressionAttributeNames: {
        "#status": "status"
      },
      ExpressionAttributeValues: {
        ":pk": `TENANT#${tenantPhone}`,
        ":skPrefix": `PAYMENT#${yearMonth}`,
        ":status": "APPROVED"
      }
    }));

    let totalRecaudado = 0;
    let mensualidadesPagadas = 0;

    if (result.Items) {
      for (const item of result.Items) {
        totalRecaudado += item.amount || 0;
        mensualidadesPagadas += item.calculatedMonths || 1;
      }
    }

    let deudaPendiente = 0;
    const debtors = await dynamo.getStudentsByTenant(tenantPhone, 'DEBTORS');
    for (const debtor of debtors) {
      if (debtor.status === 'ACTIVE') {
        deudaPendiente += debtor.planPrice || 0;
      }
    }

    return { totalRecaudado, mensualidadesPagadas, deudaPendiente };
  },

  updateTenantMonthlyFee: async (tenantPhone: string, newFee: number): Promise<boolean> => {
    try {
      await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantPhone}`, SK: 'METADATA' },
        UpdateExpression: "SET monthlyFee = :newFee",
        ExpressionAttributeValues: {
          ":newFee": newFee
        }
      }));
      return true;
    } catch (error) {
      console.error("Error updating tenant monthly fee:", error);
      return false;
    }
  },

  updateTenantSchedules: async (tenantPhone: string, newSchedules: HorarioClaseConfig[]): Promise<boolean> => {
    try {
      await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantPhone}`, SK: 'METADATA' },
        UpdateExpression: "SET config.horarios_clases = :newSchedules",
        ExpressionAttributeValues: {
          ":newSchedules": newSchedules
        }
      }));
      return true;
    } catch (error) {
      console.error("Error updating tenant schedules:", error);
      return false;
    }
  },

  saveFullConversationHistory: async (tenantPhone: string, userPhone: string, fullHistoryArray: any[]) => {
    try {
      let limitedHistory = fullHistoryArray.slice(-20);

      // Truncating can leave a leading tool_result whose tool_use was dropped; the model API rejects that.
      while (limitedHistory.length > 0) {
        const firstMsg = limitedHistory[0];
        const hasOrphanToolResult = firstMsg.role === 'user' &&
                                    Array.isArray(firstMsg.content) &&
                                    firstMsg.content.some((c: any) => c.type === 'tool_result');
        if (hasOrphanToolResult) {
          limitedHistory.shift();
        } else {
          break;
        }
      }

      await docClient.send(new PutCommand({
        TableName: process.env.DYNAMODB_TABLE!,
        Item: {
          PK: `TENANT#${tenantPhone}`,
          SK: `CONVERSATION#${userPhone}`,
          messages: limitedHistory,
          updatedAt: Date.now(),
          lastMessageAt: new Date().toISOString(),
          phone: userPhone
        }
      }));
    } catch (e) {
      console.error("Error saving full history:", e);
    }
  },
};
