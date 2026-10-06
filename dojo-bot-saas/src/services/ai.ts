import { executeTool } from './tool-executor';
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { dynamo, Payment, Tenant } from './dynamodb';
import { whatsapp } from './whatsapp';
import { generateStudentsExcelBuffer } from './excel';
import { CrossHeroService } from './crosshero';
import { CrossHeroScraper } from './crosshero-scraper';
import { getLegacyPrompt, buildDynamicPrompt } from '../agent/system-prompts';
import { secretsManager } from './secrets-manager';
import { getAvailableCourts, bookCourt, getAllCourts, cancelCourtBooking } from './googleSheets';
import { parseIsoToExcelFormat, validateDateBooking } from '../utils/dateFormatter';

export async function getScraper(tenantPhone: string, crossHeroConfig: any): Promise<CrossHeroScraper | null> {
  if (!crossHeroConfig || !crossHeroConfig.adminEmail) return null;
  const { adminEmail, adminPass, adminPassEncrypted } = crossHeroConfig;
  if (!adminPass && !adminPassEncrypted) return null;

  const decryptedPass = await secretsManager.getDecryptedSecret(tenantPhone, adminPass, adminPassEncrypted);
  if (!decryptedPass) return null;

  return new CrossHeroScraper(tenantPhone, adminEmail, decryptedPass);
}

const BaseTools = [
  {
    name: "actualizar_mi_nombre",
    description: "Actualiza tu propio nombre en la base de datos. Úsalo SI Y SOLO SI el sistema te indica que debes pedirle el nombre al usuario porque su 'Nombre en DB' actual empieza con 'Alumno Importado' o similar, y el usuario acaba de responder dándote su nombre real.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        newName: { type: "string", description: "El nombre y apellido (si te lo dio) real que el usuario acaba de entregar." }
      },
      required: ["newName"]
    }
  }
];

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

const CrossHeroTools = [
  {
    name: "buscar_alumno_en_crosshero",
    description: "Busca a un atleta en CrossHero por nombre o correo.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        nameQuery: { type: "string" }
      },
      required: ["nameQuery"]
    }
  },
  {
    name: "aprobar_pago_crosshero",
    description: "Registra o aprueba un pago en CrossHero. REGLA ESTRICTA: JAMAS inventes el athleteId. Si no tienes el ID exacto, DEBES usar primero la herramienta buscar_alumno_en_crosshero para obtenerlo.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        athleteId: { type: "string" },
        amount: { type: "number" },
        method: { type: "string", enum: ["CASH", "TRANSFER"] }
      },
      required: ["athleteId", "amount"]
    }
  },
  {
    name: "ver_horarios_crosshero",
    description: "Consulta los horarios de clases disponibles. Úsalo cuando necesites obtener el 'singleClassId' de una clase (ej: para reservar o ver asistencia), o cuando el usuario pregunte a qué hora hay clases.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        dateStr: { type: "string", description: "Fecha a consultar en formato DD/MM/YYYY. Ej: 19/08/2026" },
        programName: { type: "string", description: "Nombre del programa (ej: 'BOXEO GENERAL'). Si no estás seguro o quieres ver todas las clases del día, pasa un string vacío '' para que te devuelva TODO el horario disponible." }
      },
      required: ["dateStr"]
    }
  },
  {
    name: "reservar_clase_crosshero",
    description: "Reserva una clase en CrossHero para un alumno específico.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        dateStr: { type: "string", description: "Fecha de la clase en formato DD/MM/YYYY. Ej: 19/08/2026" },
        singleClassId: { type: "string", description: "El ID de la clase obtenido previamente con ver_horarios_crosshero" },
        studentPhone: { type: "string", description: "Teléfono del alumno" }
      },
      required: ["dateStr", "singleClassId", "studentPhone"]
    }
  },
  {
    name: "ver_asistencia_crosshero",
    description: "Permite ver la lista de asistentes para una clase en CrossHero. REGLA: Si no tienes el 'singleClassId', NO le preguntes al usuario por la hora o disciplina. Primero debes ejecutar la herramienta 'ver_horarios_crosshero' (usando programName vacío) para buscar las opciones de clases de ese día. Si solo hay una clase en el día, usa su ID inmediatamente aquí. Si hay varias, muéstrale las opciones al usuario y pregúntale de cuál quiere ver la asistencia.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        dateStr: { type: "string", description: "Fecha de la clase en formato DD/MM/YYYY. Ej: 19/08/2026" },
        singleClassId: { type: "string", description: "El ID de la clase obtenido previamente con ver_horarios_crosshero" }
      },
      required: ["dateStr", "singleClassId"]
    }
  }
];

export function getTenantTools(tenant: Tenant, role: string = 'STUDENT') {
  let tools: any[] = [];

  if (tenant.aiConfig?.customPromptVersion === 'v2' && tenant.aiConfig?.allowedTools) {
    const allAvailableTools = [...BaseTools, ...DynamoTools, ...CrossHeroTools];
    tools = allAvailableTools.filter(t => tenant.aiConfig!.allowedTools!.includes(t.name));
  } else {
    tools = [...BaseTools];

    if (role === 'ADMIN') {
      tools = [...tools, ...DynamoTools];
    } else if (role === 'COACH') {
      tools = [...tools, ...DynamoTools.filter(t => t.name === 'obtener_resumen_alumnos_texto')];
    }

    if (tenant.crossHeroConfig?.enabled && tenant.crossHeroConfig?.adminEmail) {
      let chTools = [...CrossHeroTools];
      if (role !== 'ADMIN' && role !== 'COACH') {
        chTools = chTools.filter(t => t.name !== 'ver_asistencia_crosshero');
      }
      tools = [...tools, ...chTools as any[]];
    }

    if (tenant.googleSheetsConfig?.enabled) {
      const sheetsTools = DynamoTools.filter(t => t.name === 'ver_canchas_disponibles' || t.name === 'reservar_cancha' || t.name === 'consultar_mis_reservas_dia' || t.name === 'cancelar_mi_reserva');
      tools = [...tools, ...sheetsTools];
    }
  }

  tools = Array.from(new Map(tools.map(t => [t.name, t])).values());
  console.log('DEBUG TOOLS RETURNED:', tools.map(t => t.name).join(', '));

  const clonedTools = JSON.parse(JSON.stringify(tools));
  if (!tenant.crossHeroConfig?.enabled) {
    const registrarTool = clonedTools.find((t: any) => t.name === 'registrar_nuevo_alumno');
    if (registrarTool && registrarTool.input_schema.properties.email) {
      delete registrarTool.input_schema.properties.email;
    }
  }

  return clonedTools;
}
const DynamoTools = [
  {
    name: "crear_profesor",
    description: "Crea un nuevo profesor (coach) en el sistema para esta academia.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        coachPhone: { type: "string", description: "Teléfono del profesor. Debe incluir el código de país sin el '+'. Ejemplo: 56912345678" },
        name: { type: "string", description: "Nombre del profesor" }
      },
      required: ["coachPhone", "name"]
    }
  },
  {
    name: "asignar_profesor",
    description: "Agrega un profesor a la lista de profesores de un alumno. (Soporta múltiples profesores).",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        studentPhone: { type: "string", description: "Teléfono del alumno." },
        coachPhone: { type: "string", description: "Teléfono del profesor." }
      },
      required: ["studentPhone", "coachPhone"]
    }
  },
  {
    name: "remover_profesor",
    description: "Quita a un profesor de la lista de profesores de un alumno.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        studentPhone: { type: "string", description: "Teléfono del alumno." },
        coachPhone: { type: "string", description: "Teléfono del profesor." }
      },
      required: ["studentPhone", "coachPhone"]
    }
  },
  {
    name: "listar_profesores",
    description: "Devuelve la lista de profesores registrados en la academia.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "eliminar_alumno",
    description: "Elimina permanentemente a un alumno de la base de datos de la academia. Usa esto solo cuando el dueño te pide borrar, eliminar o dar de baja a un alumno.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        studentPhone: {
          type: "string",
          description: "El NÚMERO DE TELÉFONO EXACTO del alumno que se va a eliminar."
        }
      },
      required: ["studentPhone"]
    }
  },
  {
    name: "consultar_estado_alumno",
    description: "Busca en la base de datos a un alumno por su nombre para consultar si está al día con sus pagos o si tiene deudas. DEBES ejecutar esta herramienta INMEDIATAMENTE con CUALQUIER nombre o fragmento que el usuario te haya dado. NO pidas más detalles, ejecuta la búsqueda con lo que tengas primero. Si la herramienta retorna múltiples alumnos, ENTREGA DIRECTAMENTE TODOS LOS DETALLES que te dio la herramienta (nombre completo, teléfono, días de deuda, etc.) sin ocultar nada.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        studentName: {
          type: "string",
          description: "El nombre o alias del alumno a buscar (ej. 'Juan', 'Bárbara', 'G para Vera')"
        }
      },
      required: ["studentName"]
    }
  },
  {
    name: "obtener_resumen_alumnos_texto",
    description: "Retorna una lista de alumnos filtrada. DEBES usar esta información para devolverle al dueño el nombre, días de deuda y el NÚMERO DE TELÉFONO exacto de cada alumno. Si el dueño pide 'la lista de alumnos' ASUME SIEMPRE que se refiere a los alumnos ACTIVOS y usa el filtro ACTIVE. Solo usa ALL o INACTIVE si lo pide explícitamente. Si el sistema te indica que son demasiados, ofrécele el Excel.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        filter: { type: "string", enum: ["ALL", "ACTIVE", "INACTIVE", "DEBTORS", "UP_TO_DATE", "DUE_SOON"], description: "ACTIVE por defecto. ALL para todos, INACTIVE para inactivos, DEBTORS para deudores, UP_TO_DATE para al día." },
        onlyMyStudents: { type: "boolean", description: "Si es true, filtra solo los alumnos asignados al usuario que pregunta." },
        limit: { type: "number", description: "Opcional. Límite de alumnos a retornar (ej: 10 si piden los 10 primeros)." },
        sortBy: { type: "string", enum: ["EXPIRING_SOON", "HIGHEST_DEBT"], description: "Opcional. Ordenar por los que vencen pronto (EXPIRING_SOON) o por mayor deuda (HIGHEST_DEBT)." }
      },
      required: []
    }
  },
  {
    name: "generar_reporte_excel",
    description: "Genera y envía un link con un reporte en Excel. Úsalo cuando el sistema te avise que hay muchos deudores y que ofrezcas el reporte, o si el dueño pide explícitamente un Excel. Este comando procesa en segundo plano y tú recibirás el link para mandárselo al usuario.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        filter: { type: "string", enum: ["ALL", "ACTIVE", "INACTIVE", "DEBTORS", "UP_TO_DATE", "DUE_SOON"] }
      },
      required: []
    }
  },
  {
    name: "buscar_alumno_por_nombre",
    description: "Busca en la base de datos a un alumno usando parte de su nombre. Úsalo cuando necesites saber el número de teléfono de un alumno para aprobar su pago o modificar sus datos.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        nameQuery: { type: "string", description: "El nombre o apellido a buscar (ej: 'Antonio Novoa')." }
      },
      required: ["nameQuery"]
    }
  },
  {
    name: "ver_canchas_disponibles",
    description: "Retorna los horarios disponibles separados por Cancha en formato de texto. Úsalo cuando el usuario quiera reservar una hora. Muestra los resultados en formato de WhatsApp usando listas y asteriscos para que se lea fácil. Si la API falla por límite, dile al usuario que espere un momento.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        sede: { type: "string", enum: ["vina", "curauma"], description: "Sede de la cancha." },
        dateIso: { type: "string", description: "Fecha estricta en formato ISO YYYY-MM-DD. NUNCA pases otro formato." }
      },
      required: ["sede", "dateIso"]
    }
  },
  {
    name: "reservar_cancha",
    description: "Reserva un horario en una cancha específica. Ejecuta esta herramienta cuando el cliente confirme la hora (con abono 0) para asegurar el cupo, o cuando envíe el comprobante. Si hay concurrencia y te dice 'OCCUPIED', dile al usuario que la hora acaba de ser tomada.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        sede: { type: "string", enum: ["vina", "curauma"] },
        dateIso: { type: "string", description: "Fecha estricta YYYY-MM-DD" },
        cancha: { type: "string", description: "El nombre de la cancha, ej: 'CANCHA 1'" },
        horario: { type: "string", description: "El bloque de horario, ej: '19:30'" },
        studentName: { type: "string", description: "Nombre real de la persona." },
        abono: { type: "number", description: "Monto depositado/abonado." }
      },
      required: ["sede", "dateIso", "horario", "studentName", "abono"]
    }
  },
  {
    name: "ver_estado_canchas_completo",
    description: "HERRAMIENTA DE ADMINISTRADOR: Retorna el estado completo de todas las canchas (libres y ocupadas), incluyendo el nombre de quién reservó, abonos y por pagar. Úsalo cuando el administrador te pregunte 'quién reservó' o quiera un reporte del estado de las canchas del día.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        sede: { type: "string", enum: ["vina", "curauma"] },
        dateIso: { type: "string", description: "Fecha estricta en formato ISO YYYY-MM-DD." }
      },
      required: ["sede", "dateIso"]
    }
  },
  {
    name: "consultar_mis_reservas_dia",
    description: "Busca las reservas de un usuario en un día específico. Úsalo cuando el cliente pregunte '¿qué reservas tengo hoy?' o '¿a qué hora reservé?'.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        sede: { type: "string", enum: ["vina", "curauma"] },
        dateIso: { type: "string", description: "Fecha estricta YYYY-MM-DD" },
        miNombre: { type: "string", description: "El nombre del usuario que está hablando contigo" }
      },
      required: ["sede", "dateIso", "miNombre"]
    }
  },
  {
    name: "cancelar_mi_reserva",
    description: "Cancela la reserva de un cliente (NO ADMIN). El sistema verificará automáticamente por seguridad que la reserva pertenezca a este nombre antes de borrarla.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        sede: { type: "string", enum: ["vina", "curauma"] },
        dateIso: { type: "string", description: "Fecha estricta YYYY-MM-DD" },
        cancha: { type: "string", description: "Nombre de la cancha (ej: 'CANCHA 1')" },
        horario: { type: "string", description: "Bloque de horario (ej: '19:30')" },
        miNombre: { type: "string", description: "El nombre del usuario que está hablando contigo" }
      },
      required: ["sede", "dateIso", "cancha", "horario", "miNombre"]
    }
  },
  {
    name: "cancelar_reserva_cancha",
    description: "HERRAMIENTA DE ADMINISTRADOR: Cancela la reserva de una cancha específica, borrando el nombre y el abono, dejándola libre nuevamente. Úsalo cuando el dueño te ordene cancelar o liberar una reserva.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        sede: { type: "string", enum: ["vina", "curauma"] },
        dateIso: { type: "string", description: "Fecha estricta YYYY-MM-DD" },
        cancha: { type: "string", description: "Nombre de la cancha (ej: 'CANCHA 1')" },
        horario: { type: "string", description: "Bloque de horario (ej: '19:30')" }
      },
      required: ["sede", "dateIso", "cancha", "horario"]
    }
  },
  {
    name: "aprobar_pago",
    description: "Aprueba el pago pendiente de un alumno y extiende su fecha de pago. También sirve para registrar un PAGO MANUAL si el dueño te dice que alguien pagó pero no hay comprobante en el sistema. Además, si el dueño menciona el nombre real del alumno y no coincide con el de la base de datos, envía ese nombre en el parámetro 'studentName' para actualizarlo automáticamente.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        studentPhone: { type: "string", description: "El número de teléfono exacto del alumno al que se le aprobará el pago. Si solo tienes su nombre, usa PRIMERO la herramienta 'buscar_alumno_por_nombre' para encontrar su teléfono. ¡NUNCA le pidas el teléfono al dueño si puedes buscarlo por el nombre!" },
        forgiveDebt: { type: "boolean", description: "Opcional. Si es true, su fecha de cobro se reseteará a la fecha de hoy, perdonando cualquier mes atrasado que no haya cubierto. Si es false o no se envía, solo avanzará los meses exactos que pagó." },
        studentName: { type: "string", description: "Opcional. El nombre real del alumno que el administrador indicó en el mensaje (ej: 'Juan Tapia'). Si se envía, actualizará su nombre en la base de datos." },
        retroactiveDate: { type: "string", description: "Opcional. Fecha en formato ISO (ej: '2026-08-14T00:00:00Z') si el administrador indicó explícitamente que el pago se hizo en el pasado. Si no lo especifica, no envíes este parámetro y se usará la fecha actual." }
      },
      required: ["studentPhone"]
    }
  },
  {
    name: "gestionar_estado_alumno",
    description: "Actualiza el estado de un alumno (dar de baja, congelar o activar).",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        studentName: { type: "string" },
        newStatus: { type: "string", enum: ["ACTIVE", "INACTIVE", "FROZEN"] }
      },
      required: ["studentName", "newStatus"]
    }
  },
  {
    name: "registrar_nuevo_alumno",
    description: "Registra un nuevo alumno en la base de datos.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        name: { type: "string" },
        phone: { type: "string", description: "El número de teléfono EXACTO entregado por el administrador. NUNCA alteres, agregues (como un '9' extra) ni quites dígitos. Solo limpia los espacios." },
        email: { type: "string", description: "Opcional. El correo electrónico del alumno. NO se lo pidas al usuario a menos que el administrador te lo entregue explícitamente en el mensaje." },
        planPrice: { type: "number", description: "El valor mensual del plan que pagará el alumno." },
        paymentDay: { type: "number", description: "El día del mes en que le tocará pagar." },
        hasPaidInitial: { type: "boolean", description: "Si ya pagó su primer mes al inscribirse o no." }
      },
      required: ["name", "phone", "planPrice", "paymentDay", "hasPaidInitial"]
    }
  },
  {
    name: "revertir_ultimo_pago",
    description: "Revierte el último pago aprobado de un alumno, restando los meses añadidos a su fecha de vencimiento y marcando el pago como revertido. Úsalo si te equivocas o si te piden deshacer el pago.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        studentName: { type: "string", description: "El nombre o teléfono del alumno al que se le revertirá el pago." }
      },
      required: ["studentName"]
    }
  },
  {
    name: "modificar_datos_alumno",
    description: "Actualiza los datos de cobro de un alumno (precio del plan, día de cobro o nombre). No uses esta herramienta si el usuario quiere cambiar su número de celular (en ese caso, debes darlo de baja y registrarlo de nuevo).",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        studentName: { type: "string", description: "El nombre o alias del alumno a buscar" },
        newPlanPrice: { type: "number", description: "Opcional. El nuevo valor mensual del plan." },
        newPaymentDay: { type: "number", description: "Opcional. El nuevo día de pago del mes." },
        newName: { type: "string", description: "Opcional. El nombre corregido del alumno." }
      },
      required: ["studentName"]
    }
  },
  {
    name: "migrar_numero_alumno",
    description: "Migra el perfil de un alumno cuando cambia de número de teléfono. Usa esta herramienta cuando el dueño indica que un alumno cambió de número.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        telefono_antiguo: { type: "string", description: "El número de teléfono antiguo del alumno (sin el +)" },
        telefono_nuevo: { type: "string", description: "El número de teléfono nuevo del alumno (sin el +)" }
      },
      required: ["telefono_antiguo", "telefono_nuevo"]
    }
  },
  {
    name: "obtener_reporte_financiero",
    description: "Genera un reporte financiero con el total recaudado, cantidad de mensualidades pagadas y monto pendiente por cobrar. Úsalo cuando el dueño pregunte por finanzas, ganancias, pagos totales o recaudación. Si no especifica el mes, se usa el mes actual.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        yearMonth: { type: "string", description: "Opcional. El mes a consultar en formato YYYY-MM. Si no se provee, se usará el mes actual." }
      },
      required: []
    }
  },
  {
    name: "actualizar_precio_global",
    description: "Actualiza el precio base mensual global de la academia. Úsalo cuando el dueño quiera subir o bajar la mensualidad estándar para toda la academia (ej: 'Desde hoy el plan sube a 40000').",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        newMonthlyFee: { type: "number", description: "El nuevo valor mensual global de la academia." }
      },
      required: ["newMonthlyFee"]
    }
  },
  {
    name: "gestionar_horarios_clases",
    description: "Modifica la configuración global de horarios de clases de la academia. Lee los horarios actuales desde tu system prompt, aplica el cambio solicitado por el usuario, y envía la lista completa resultante. IMPORTANTE: Debes enviar el arreglo COMPLETO de horarios, no solo el modificado.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        newSchedules: {
          type: "array",
          description: "El arreglo completo y actualizado con TODOS los horarios de clases de la semana.",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              dia: { type: "string", description: "Día de la semana (Lunes, Martes, etc.)" },
              hora_inicio: { type: "string", description: "Hora de inicio en formato HH:MM" },
              hora_fin: { type: "string", description: "Hora de término en formato HH:MM" },
              disciplina: { type: "string", description: "Nombre de la clase o disciplina y profesor" }
            },
            required: ["dia", "hora_inicio", "hora_fin", "disciplina"]
          }
        }
      },
      required: ["newSchedules"]
    }
  },
  {
    name: "leer_historial_alumno",
    description: "Lee el historial de chat (los mensajes anteriores) entre el bot y un alumno específico. Útil cuando el administrador te pide que le resumas de qué hablaste con alguien o qué te dijo un alumno.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        identificador_alumno: { type: "string", description: "El nombre o número de teléfono del alumno a buscar." }
      },
      required: ["identificador_alumno"]
    }
  },
  {
    name: "obtener_conversaciones_recientes",
    description: "Recupera un resumen de todas las conversaciones que el bot ha tenido con alumnos o prospectos durante las últimas 24 horas. Útil cuando el administrador quiere saber con quién hablaste hoy o qué ha pasado hoy.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {},
      required: []
    }
  }
];

export const invokeClaudeHaiku = async (
  systemPromptFallback: string,
  conversationHistory: any[],
  userMessage: string,
  tenant: Tenant,
  userPhone: string,
  phoneNumberId: string,
  role: string,
  image?: { base64: string, mimeType: string }
) => {
  const tenantPhone = tenant.PK.replace('TENANT#', '');
  const crossHeroEnabled = tenant.crossHeroConfig?.enabled || false;

  let systemPrompt = systemPromptFallback;

  const messages = [...conversationHistory];

  let currentContent: any[] = [];

  if (image) {
    currentContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: image.base64
      }
    });
  }

  currentContent.push({
    type: "text",
    text: userMessage
  });

  messages.push({
    role: "user",
    content: currentContent
  });

  let keepRunning = true;
  let finalResultBody = null;

  while (keepRunning) {
    const payload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1500,
      system: systemPrompt,
      messages: messages,
      tools: getTenantTools(tenant, role)
    };

    const command = new InvokeModelCommand({
      modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload),
    });

    const response = await bedrockClient.send(command);
    let resultBody;
    try {
      resultBody = JSON.parse(new TextDecoder().decode(response.body));
    } catch (error: any) {
      console.error('Critical Error parsing Bedrock JSON:', error);
      throw new Error(`Bedrock JSON Parse Error: ${error.message}`);
    }
    finalResultBody = resultBody;

    if (resultBody.stop_reason === "tool_use") {
      messages.push({
        role: "assistant",
        content: resultBody.content
      });

      const toolUseBlocks = resultBody.content.filter((block: any) => block.type === "tool_use");
      console.log("TOOL CALLS DETECTED:", JSON.stringify(toolUseBlocks));

      if (toolUseBlocks.length > 0) {
        const toolResultContent = [];

        for (const toolUseBlock of toolUseBlocks) {
          let toolResultStr = "";

          toolResultStr = await executeTool(toolUseBlock, { tenant, tenantPhone, fromPhone: userPhone, phoneNumberId: phoneNumberId || '', role });

          toolResultContent.push({
            type: "tool_result",
            tool_use_id: toolUseBlock.id,
            content: toolResultStr
          });
        }

        if (keepRunning) {
          messages.push({
            role: "user",
            content: toolResultContent
          });
        }
      } else {
        keepRunning = false;
      }
    } else {
      keepRunning = false;
    }
  }

    if (finalResultBody && finalResultBody.content && finalResultBody.stop_reason !== "tool_use") { messages.push({ role: "assistant", content: finalResultBody.content }); } const textBlocks = finalResultBody?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text) || []; return { text: textBlocks.join("\n"), history: messages };
};
