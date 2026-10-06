import { executeTool } from './tool-executor';
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { dynamo, Tenant, Payment } from './dynamodb';
import { getTenantTools, getScraper } from './ai';
import { getAvailableCourts, bookCourt, getAllCourts, cancelCourtBooking } from './googleSheets';
import { parseIsoToExcelFormat, validateDateBooking } from '../utils/dateFormatter';
import { generateStudentsExcelBuffer } from './excel';
import { CrossHeroService } from './crosshero';
import { whatsapp } from './whatsapp';

const bedrockClient = new BedrockRuntimeClient({ region: "us-east-1" });

export const invokeNovaLite = async (
  systemPrompt: string,
  conversationHistory: any[],
  userMessage: string,
  tenant: Tenant,
  userPhone: string,
  phoneNumberId: string,
  role: string,
  image?: { base64: string, mimeType: string }
) => {
  const tenantPhone = tenant.PK.replace('TENANT#', '');

  const mappedMessages = conversationHistory.map(msg => {
    let content = [];
    if (typeof msg.content === 'string') {
      content.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map((block: any) => {
        if (block.type === 'text') return { text: block.text };
        if (block.type === 'tool_use') return { toolUse: { toolUseId: block.id, name: block.name, input: block.input } };
        if (block.type === 'tool_result') {
          return { toolResult: { toolUseId: block.tool_use_id, content: [{ text: block.content }] } };
        }
        return { text: JSON.stringify(block) };
      });
    }
    return { role: msg.role, content };
  });

  let currentContent: any[] = [];
  if (image) {
    currentContent.push({
      image: { format: image.mimeType.split('/')[1] || "jpeg", source: { bytes: Buffer.from(image.base64, 'base64') } }
    });
  }
  currentContent.push({ text: userMessage });
  mappedMessages.push({ role: "user", content: currentContent });

  const anthropicTools = getTenantTools(tenant, role);
  const converseTools = anthropicTools.map((t:any) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.input_schema }
    }
  }));

  let keepRunning = true;
  let finalResponseText = "";

  while (keepRunning) {
    const command = new ConverseCommand({
      modelId: "amazon.nova-lite-v1:0",
      messages: mappedMessages,
      system: [{ text: systemPrompt }],
      inferenceConfig: { maxTokens: 1500 },
      toolConfig: { tools: converseTools }
    });

    const response = await bedrockClient.send(command);
    const outputMsg = response.output?.message;

    if (!outputMsg) throw new Error("No message in Bedrock Converse response");
    mappedMessages.push(outputMsg);

    const textBlocks = outputMsg.content?.filter((c: any) => c.text).map((c: any) => c.text);
    if (textBlocks && textBlocks.length > 0) {
      finalResponseText = textBlocks.join("\n");
    }

    if (response.stopReason === "tool_use") {
      const toolUseBlocks = outputMsg.content?.filter((c: any) => c.toolUse).map((c: any) => c.toolUse) || [];
      console.log("NOVA TOOL CALLS DETECTED:", JSON.stringify(toolUseBlocks));

      const toolResultContent: any[] = [];
      for (const block of toolUseBlocks) {
        let toolResultStr = "";
        try {
            if (block.name === "consultar_estado_alumno") {
              const studentName = block.input.studentName;
              toolResultStr = await dynamo.checkStudentStatusByName(tenantPhone, studentName);
            } else if (block.name === "ver_horarios_crosshero") {
              const { dateStr, programName } = block.input;
              if (tenant.crossHeroConfig?.adminEmail) {
                try {
                  const scraper = await getScraper(tenantPhone, tenant.crossHeroConfig);
                  if (!scraper) throw new Error("Credenciales de CrossHero no disponibles o inválidas.");
                  const classes = await scraper.getAvailableClasses(dateStr, programName);
                  if (classes.length > 0) {
                    const classLines = classes.map(c => `- Programa: ${c.program} - Hora: ${c.time} (ID: ${c.singleClassId})`).join('\n');
                    const metadataBlock = classes.map(c => `${c.time}|${c.program}|${c.singleClassId}`).join(';');
                    toolResultStr = `Horarios encontrados para ${programName} el ${dateStr}:\n${classLines}\n\nIMPORTANTE: Cuando le muestres las opciones al alumno, DEBES incluir al final de tu mensaje (después de la lista visible) el siguiente bloque oculto EXACTAMENTE así, sin modificarlo:\n[CLASES_DISPONIBLES:${dateStr}:${metadataBlock}]\nEste bloque es INVISIBLE para el alumno pero tú lo necesitas para poder reservar después. Si no lo incluyes, perderás los IDs y no podrás agendar.`;
                  } else {
                    toolResultStr = `No se encontraron horarios para ${programName} el ${dateStr}.`;
                  }
                } catch (e: any) {
                  toolResultStr = "Error al consultar CrossHero: " + e.message;
                }
              } else {
                toolResultStr = "CrossHero Scraper no está configurado.";
              }
            } else if (block.name === "reservar_clase_crosshero") {
              const { dateStr, singleClassId, studentPhone } = block.input;
              const student = await dynamo.getStudent(tenantPhone, studentPhone);
              if (!student) {
                toolResultStr = "Error: Alumno no encontrado en la base de datos.";
              } else if (!student.crossHeroId) {
                toolResultStr = "Error: El alumno no tiene asociado un ID de CrossHero. Dile que le hable al admin.";
              } else if (tenant.crossHeroConfig?.adminEmail) {
                try {
                  const scraper = await getScraper(tenantPhone, tenant.crossHeroConfig);
                  if (!scraper) throw new Error("Credenciales inválidas.");
                  await scraper.bookClass(dateStr, singleClassId, student.crossHeroId);
                  toolResultStr = `Clase reservada con éxito en CrossHero para ${student.name} el ${dateStr}.`;
                } catch (e: any) {
                  toolResultStr = "Error al reservar en CrossHero: " + e.message;
                }
              } else {
                toolResultStr = "CrossHero Scraper no está configurado.";
              }
            } else if (block.name === "ver_asistencia_crosshero") {
              const { dateStr, singleClassId } = block.input;
              if (tenant.crossHeroConfig?.adminEmail) {
                try {
                  const scraper = await getScraper(tenantPhone, tenant.crossHeroConfig);
                  if (!scraper) throw new Error("Credenciales inválidas.");
                  const attendees = await scraper.getClassAttendees(dateStr, singleClassId);
                  if (attendees.length === 0) {
                    toolResultStr = `Nadie ha reservado aún para esta clase.`;
                  } else {
                    toolResultStr = `Asistentes:\n` + attendees.map(a => `- ${a.name} (${a.status})`).join('\n');
                  }
                } catch (e: any) {
                  toolResultStr = "Error al consultar asistentes en CrossHero: " + e.message;
                }
              } else {
                toolResultStr = "CrossHero Scraper no está configurado.";
              }
            } else if (block.name === "crear_profesor") {
              const { coachPhone, name } = block.input;
              await dynamo.createCoach(tenantPhone, coachPhone, name);
              toolResultStr = `Profesor creado con éxito: ${name} (${coachPhone})`;
            } else if (block.name === "asignar_profesor") {
              const { studentPhone, coachPhone } = block.input;
              const coach = await dynamo.getCoach(tenantPhone, coachPhone);
              if (!coach) {
                toolResultStr = `Error: El profesor con teléfono ${coachPhone} no existe en la base de datos. Créalo primero.`;
              } else {
                await dynamo.assignCoachToStudent(tenantPhone, studentPhone, coachPhone);
                toolResultStr = `Alumno ${studentPhone} asignado exitosamente al profesor ${coach.name}`;
              }
            } else if (block.name === "remover_profesor") {
              const { studentPhone, coachPhone } = block.input;
              await dynamo.removeCoachFromStudent(tenantPhone, studentPhone, coachPhone);
              toolResultStr = `Profesor removido exitosamente del alumno ${studentPhone}.`;
            } else if (block.name === "listar_profesores") {
              const coaches = await dynamo.getCoachesByTenant(tenantPhone);
              if (coaches.length === 0) {
                toolResultStr = "No hay profesores registrados en la academia.";
              } else {
                toolResultStr = JSON.stringify(coaches.map(c => ({ nombre: c.name, telefono: c.phone })));
              }
            } else if (block.name === "obtener_resumen_alumnos_texto") {
              let filter = block.input.filter || 'ACTIVE';
              if (filter === 'ALL') filter = 'ACTIVE';
              const coachPhoneFilter = (role === 'COACH' || block.input.onlyMyStudents) ? userPhone : undefined;
              let students = await dynamo.getStudentsByTenant(tenantPhone, filter, coachPhoneFilter);

              const today = new Date();
              today.setHours(0,0,0,0);

              if (block.input.sortBy === 'EXPIRING_SOON') {
                 students.sort((a, b) => {
                    if (!a.paidUntilDate) return 1;
                    if (!b.paidUntilDate) return -1;
                    return new Date(a.paidUntilDate).getTime() - new Date(b.paidUntilDate).getTime();
                 });
              } else if (block.input.sortBy === 'HIGHEST_DEBT') {
                 students.sort((a, b) => {
                    const debtA = !a.paidUntilDate ? 9999 : (today.getTime() - new Date(a.paidUntilDate).getTime());
                    const debtB = !b.paidUntilDate ? 9999 : (today.getTime() - new Date(b.paidUntilDate).getTime());
                    return debtB - debtA;
                 });
              }

              if (block.input.limit) {
                 students = students.slice(0, block.input.limit);
              }

              if (students.length <= 60) {
                const coaches = await dynamo.getCoachesByTenant(tenantPhone);
                const coachMap = new Map(coaches.map(c => [c.SK, c.name]));

                toolResultStr = JSON.stringify(students.map(s => {
                  let daysOverdue: string | number = 0;
                  if (s.paidUntilDate) {
                    const paidUntil = new Date(s.paidUntilDate);
                    paidUntil.setHours(0,0,0,0);
                    if (paidUntil < today) {
                      daysOverdue = Math.floor((today.getTime() - paidUntil.getTime()) / (1000 * 3600 * 24));
                    }
                  } else {
                    daysOverdue = "PENDIENTE DE PAGO INICIAL";
                  }
                  const phoneParts = s.SK.split('#');
                  const studentPhone = phoneParts.length > 1 ? phoneParts[1] : s.SK;

                  let coachName = "Sin Profesor";
                  if (s.assignedCoaches && s.assignedCoaches.length > 0) {
                    coachName = s.assignedCoaches.map(c => coachMap.get(c) || c.replace('COACH#', '')).join(', ');
                  } else if (s.assignedCoach) {
                    coachName = coachMap.get(s.assignedCoach) || s.assignedCoach.replace('COACH#', '');
                  }

                  return {
                    name: s.name,
                    phone: studentPhone,
                    status: s.status === 'ACTIVE' ? 'Inscrita' : s.status,
                    paymentDay: s.paymentDay,
                    planPrice: s.planPrice,
                    paidUntilDate: s.paidUntilDate || "Desconocido",
                    estadoDePago: !s.paidUntilDate ? "NO HA PAGADO NUNCA (DEUDOR)" : ((typeof daysOverdue === 'number' && daysOverdue > 0) ? "DEUDOR" : "AL DÍA"),
                    daysOverdue,
                    profesor: coachName
                  };
                }));
              } else {
                if (filter === 'ACTIVE') {
                  const allStudents = await dynamo.getStudentsByTenant(tenantPhone, 'ACTIVE', coachPhoneFilter);
                  const actives = allStudents.length;
                  toolResultStr = JSON.stringify({
                    count: actives,
                    message: "La lista excede los 50 registros. Dile al usuario que hay demasiados para mostrarlos por chat y ofrécele generar el reporte en Excel."
                  });
                } else {
                  toolResultStr = JSON.stringify({
                    count: students.length,
                    message: "La lista excede los 50 registros. Comunícale al usuario la cantidad total y ofrécele generar el reporte en Excel."
                  });
                }
              }
            } else if (block.name === "generar_reporte_excel") {
              let filter = block.input.filter || 'ACTIVE';
              if (filter === 'ALL') filter = 'ACTIVE';
              const students = await dynamo.getStudentsByTenant(tenantPhone, filter);

              const coaches = await dynamo.getCoachesByTenant(tenantPhone);
              const coachMap = new Map(coaches.map(c => [c.SK, c.name]));

              const buffer = await generateStudentsExcelBuffer(students, coachMap);
              let filename = 'Reporte_Alumnos.xlsx';
              if (filter === 'DEBTORS') filename = 'Reporte_Deudores.xlsx';
              else if (filter === 'UP_TO_DATE') filename = 'Reporte_Al_Dia.xlsx';
              else if (filter === 'DUE_SOON') filename = 'Reporte_Por_Vencer.xlsx';

              if (tenant.provider === 'EVOLUTION' && tenant.evolutionInstanceName) {
                await whatsapp.sendDocumentEvolution(tenant.evolutionInstanceName, userPhone, buffer, filename, "Aquí tienes tu reporte en Excel.");
              } else {
                const mediaId = await whatsapp.uploadMediaToWhatsApp(phoneNumberId, buffer, filename);
                await whatsapp.sendDocumentMessage(phoneNumberId, userPhone, mediaId, filename, "Aquí tienes tu reporte en Excel.");
              }

              toolResultStr = "Excel generado y enviado correctamente al WhatsApp del usuario.";
            } else if (block.name === "actualizar_mi_nombre") {
              const { newName } = block.input;
              await dynamo.updateStudentNameByPhone(tenantPhone, userPhone, newName);
              toolResultStr = `Tu nombre en el sistema ha sido actualizado a "${newName}". Agradécele amigablemente y pregúntale en qué más le puedes ayudar hoy.`;
            } else if (block.name === "buscar_alumno_por_nombre") {
              const { nameQuery } = block.input;
              const students = await dynamo.findStudentsByName(tenantPhone, nameQuery);
              if (students.length === 0) {
                toolResultStr = `No se encontró ningún alumno que coincida con "${nameQuery}". Tendrás que pedirle el número de teléfono al administrador.`;
              } else {
                toolResultStr = `Se encontraron los siguientes alumnos:\n` + students.map(s => `- Nombre: ${s.name}, Teléfono: ${s.SK.split('#')[1]}, Estado: ${s.status}`).join('\n');
              }
            } else if (block.name === "ver_canchas_disponibles") {
              const { sede, dateIso } = block.input;
              if (!tenant.googleSheetsConfig?.enabled || !tenant.googleSheetsConfig.spreadsheetIds) {
                toolResultStr = "Las canchas no están configuradas para este cliente.";
              } else {
                const maxDays = tenant.googleSheetsConfig.maxAdvanceBookingDays || 30;
                const dateValidation = validateDateBooking(dateIso, maxDays);
                if (!dateValidation.valid) {
                  toolResultStr = `ERROR: ${dateValidation.error}`;
                } else {
                  const sheetId = sede === 'vina' ? tenant.googleSheetsConfig.spreadsheetIds.vina : tenant.googleSheetsConfig.spreadsheetIds.curauma;
                  if (!sheetId) {
                    toolResultStr = `ERROR: No hay Excel configurado para la sede ${sede}.`;
                  } else {
                    const excelDate = parseIsoToExcelFormat(dateIso);
                    try {
                      let available = await getAvailableCourts(sheetId, excelDate);

                      const nowSantiago = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Santiago"}));
                      const todayIso = nowSantiago.getFullYear() + "-" + String(nowSantiago.getMonth()+1).padStart(2, '0') + "-" + String(nowSantiago.getDate()).padStart(2, '0');
                      const currentHour = nowSantiago.getHours();
                      const currentMinute = nowSantiago.getMinutes();
                      console.log("DEBUG TIME FILTER: todayIso=" + todayIso + " dateIso=" + dateIso + " currentHour=" + currentHour + " currentMinute=" + currentMinute + " availableBefore=" + available.length);

                      if (dateIso === todayIso) {
                          available = available.filter(a => {
                              let m = a.horario.match(/(\d{2}):(\d{2})/);
                              if (m) {
                                  const h = parseInt(m[1]);
                                  const min = parseInt(m[2]);
                                  if (h < currentHour || (h === currentHour && min <= currentMinute)) {
                                      return false;
                                  }
                              }
                              return true;
                          });
                      }

                      console.log("DEBUG TIME FILTER: availableAfter=" + available.length);
                      if (available.length === 0) {
                        toolResultStr = `No hay horas disponibles en ${sede} para el ${dateIso} (${excelDate}). Todo está ocupado.`;
                      } else {
                        const grouped: Record<string, string[]> = {};
                        available.forEach(a => {
                          if (!grouped[a.cancha]) grouped[a.cancha] = [];
                          grouped[a.cancha].push(a.horario);
                        });
                        toolResultStr = `Horas disponibles en ${sede} para el ${dateIso} (${excelDate}):\n`;
                        for (const [cancha, horarios] of Object.entries(grouped)) {
                          toolResultStr += `\n*${cancha}*\n` + horarios.map(h => { let m = h.match(/(\d{2}:\d{2})/); return m ? `- ${m[1]}` : `- ${h}`; }).join('\n');
                        }
                      }
                    } catch (e: any) {
                      if (e.message === 'RATE_LIMIT') {
                        toolResultStr = "ERROR: La API de Google está saturada. Pídele al usuario que espere unos segundos mientras el sistema procesa.";
                      } else {
                        toolResultStr = `ERROR al leer Google Sheets: ${e.message}`;
                      }
                    }
                  }
                }
              }
            } else if (block.name === "reservar_cancha") {
              const { sede, dateIso, cancha, horario, studentName, abono } = block.input;
              if (!tenant.googleSheetsConfig?.enabled || !tenant.googleSheetsConfig.spreadsheetIds) {
                toolResultStr = "Las canchas no están configuradas para este cliente.";
              } else {
                const maxDays = tenant.googleSheetsConfig.maxAdvanceBookingDays || 30;
                const dateValidation = validateDateBooking(dateIso, maxDays);
                if (!dateValidation.valid) {
                  toolResultStr = `ERROR: ${dateValidation.error}`;
                } else {
                  const sheetId = sede === 'vina' ? tenant.googleSheetsConfig.spreadsheetIds.vina : tenant.googleSheetsConfig.spreadsheetIds.curauma;
                  if (!sheetId) {
                    toolResultStr = `ERROR: No hay Excel configurado para la sede ${sede}.`;
                  } else {
                    const excelDate = parseIsoToExcelFormat(dateIso);
                    try {
  const available = await getAvailableCourts(sheetId, excelDate);
  let rawHorario = horario;
  for (const a of available) {
    if (a.cancha === cancha && a.horario.includes(horario)) {
      rawHorario = a.horario;
      break;
    }
  }
  await bookCourt(sheetId, excelDate, cancha, rawHorario, studentName, abono);
                      toolResultStr = `¡Éxito! La reserva quedó registrada en vivo en el Excel para ${studentName} el ${dateIso} (${excelDate}) a las ${horario} en ${cancha}, con un abono de $${abono}.`;
                    } catch (e: any) {
                      if (e.message === 'OCCUPIED') {
                        toolResultStr = "ERROR: ¡Alguien más acaba de tomar esa hora justo ahora! Dile al usuario que por favor elija otro horario.";
                      } else if (e.message === 'RATE_LIMIT') {
                        toolResultStr = "ERROR: La API de Google está saturada. Pídele al usuario que espere unos segundos y vuelve a intentar la reserva.";
                      } else {
                        toolResultStr = `ERROR al escribir en Google Sheets: ${e.message}`;
                      }
                    }
                  }
                }
              }
            } else if (block.name === "ver_estado_canchas_completo") {
              const { sede, dateIso } = block.input;
              if (!tenant.googleSheetsConfig?.enabled || !tenant.googleSheetsConfig.spreadsheetIds) {
                toolResultStr = "Las canchas no están configuradas para este cliente.";
              } else {
                const sheetId = sede === 'vina' ? tenant.googleSheetsConfig.spreadsheetIds.vina : tenant.googleSheetsConfig.spreadsheetIds.curauma;
                if (!sheetId) {
                  toolResultStr = `ERROR: No hay Excel configurado para la sede ${sede}.`;
                } else {
                  const excelDate = parseIsoToExcelFormat(dateIso);
                  try {
                    const allCourts = await getAllCourts(sheetId, excelDate);
                    if (allCourts.length === 0) {
                      toolResultStr = `No hay datos en ${sede} para el ${dateIso} (${excelDate}).`;
                    } else {
                      let output = `Reporte completo de canchas en ${sede} para el ${dateIso} (${excelDate}):\n`;
                      const grouped: Record<string, typeof allCourts> = {};
                      allCourts.forEach(c => {
                        if (!grouped[c.cancha]) grouped[c.cancha] = [];
                        grouped[c.cancha].push(c);
                      });
                      const nowSantiago = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Santiago"}));
                      const todayIso = nowSantiago.getFullYear() + "-" + String(nowSantiago.getMonth()+1).padStart(2, '0') + "-" + String(nowSantiago.getDate()).padStart(2, '0');
                      const currentHour = nowSantiago.getHours();
                      const currentMinute = nowSantiago.getMinutes();

                      for (const [cancha, slots] of Object.entries(grouped)) {
                        output += `\n*${cancha}*\n`;
                        slots.forEach(s => {
                          let isPast = false;
                          if (dateIso === todayIso) {
                            let m = s.horario.match(/(\d{2}):(\d{2})/);
                            if (m) {
                              const h = parseInt(m[1]);
                              const min = parseInt(m[2]);
                              if (h < currentHour || (h === currentHour && min <= currentMinute)) {
                                isPast = true;
                              }
                            }
                          }

                          let displayTime = s.horario;
                          let m2 = s.horario.match(/(\d{2}:\d{2})/);
                          if (m2) displayTime = m2[1];

                          if (s.estado === 'LIBRE') {
                            output += `- ${displayTime}: LIBRE ${isPast ? '(Ya pasó)' : ''}\n`;
                          } else {
                            output += `- ${displayTime}: OCUPADO por ${s.nombre} (Abono: ${s.abono}, Por Pagar: ${s.porPagar})${isPast ? ' (Ya pasó)' : ''}\n`;
                          }
                        });
                      }
                      toolResultStr = output;
                    }
                  } catch (e: any) {
                    toolResultStr = `ERROR al leer Google Sheets: ${e.message}`;
                  }
                }
              }
            } else if (block.name === "consultar_mis_reservas_dia") {
              const { sede, dateIso, miNombre } = block.input;
              if (!tenant.googleSheetsConfig?.enabled || !tenant.googleSheetsConfig.spreadsheetIds) {
                toolResultStr = "Las canchas no están configuradas.";
              } else {
                const sheetId = sede === 'vina' ? tenant.googleSheetsConfig.spreadsheetIds.vina : tenant.googleSheetsConfig.spreadsheetIds.curauma;
                if (!sheetId) {
                  toolResultStr = `ERROR: No hay Excel configurado para ${sede}.`;
                } else {
                  const excelDate = parseIsoToExcelFormat(dateIso);
                  try {
                    const allCourts = await getAllCourts(sheetId, excelDate);
                    const safeName = miNombre.toLowerCase().trim();
                    const misReservas = allCourts.filter((c) => c.estado === 'OCUPADA' && c.nombre && c.nombre.toLowerCase().trim().includes(safeName));
                    if (misReservas.length === 0) {
                      toolResultStr = `No tienes ninguna reserva registrada bajo el nombre '${miNombre}' para el día ${dateIso} en ${sede}.`;
                    } else {
                      toolResultStr = `Tus reservas en ${sede} para el ${dateIso}:\n` + misReservas.map((c) => {
                        let m = c.horario.match(/(\d{2}:\d{2})/);
                        let ts = m ? m[1] : c.horario;
                        return `- ${c.cancha} a las ${ts} | Abono pagado: ${c.abono} | Saldo pendiente: ${c.porPagar}`;
                      }).join('\n');
                    }
                  } catch(e: any) {
                    toolResultStr = `ERROR: ${e.message}`;
                  }
                }
              }
            } else if (block.name === "cancelar_mi_reserva") {
              const { sede, dateIso, cancha, horario, miNombre } = block.input;
              if (!tenant.googleSheetsConfig?.enabled || !tenant.googleSheetsConfig.spreadsheetIds) {
                toolResultStr = "Las canchas no están configuradas.";
              } else {
                const sheetId = sede === 'vina' ? tenant.googleSheetsConfig.spreadsheetIds.vina : tenant.googleSheetsConfig.spreadsheetIds.curauma;
                if (!sheetId) {
                  toolResultStr = `ERROR: No hay Excel configurado para ${sede}.`;
                } else {
                  const excelDate = parseIsoToExcelFormat(dateIso);
                  try {
                    const allCourts = await getAllCourts(sheetId, excelDate);
                    let reserva = null;
                    let rawHorario = horario;
                    for (const a of allCourts) {
                      if (a.cancha === cancha && a.horario.includes(horario) && a.estado === 'OCUPADA') {
                        reserva = a;
                        rawHorario = a.horario;
                        break;
                      }
                    }
                    if (!reserva) {
                      toolResultStr = `No se encontró ninguna reserva activa en la ${cancha} a las ${horario}.`;
                    } else {
                      const safeName = miNombre.toLowerCase().trim();
                      if (!reserva.nombre || !reserva.nombre.toLowerCase().trim().includes(safeName)) {
                        toolResultStr = `ALERTA DE SEGURIDAD: Esa reserva está a nombre de '${reserva.nombre}', no a nombre de '${miNombre}'. No tienes permiso para cancelar la reserva de otra persona.`;
                      } else {
                        await cancelCourtBooking(sheetId, excelDate, cancha, rawHorario);
                        toolResultStr = `¡Tu reserva fue cancelada con éxito! La cancha ${cancha} a las ${horario} quedó liberada.`;
                      }
                    }
                  } catch(e: any) {
                    toolResultStr = `ERROR al cancelar: ${e.message}`;
                  }
                }
              }
            } else if (block.name === "cancelar_reserva_cancha") {
              const { sede, dateIso, cancha, horario } = block.input;
              if (!tenant.googleSheetsConfig?.enabled || !tenant.googleSheetsConfig.spreadsheetIds) {
                toolResultStr = "Las canchas no están configuradas para este cliente.";
              } else {
                const sheetId = sede === 'vina' ? tenant.googleSheetsConfig.spreadsheetIds.vina : tenant.googleSheetsConfig.spreadsheetIds.curauma;
                if (!sheetId) {
                  toolResultStr = `ERROR: No hay Excel configurado para la sede ${sede}.`;
                } else {
                  const excelDate = parseIsoToExcelFormat(dateIso);
                  try {
  const allCourts = await getAllCourts(sheetId, excelDate);
  let rawHorario = horario;
  for (const a of allCourts) {
    if (a.cancha === cancha && a.horario.includes(horario)) {
      rawHorario = a.horario;
      break;
    }
  }
  await cancelCourtBooking(sheetId, excelDate, cancha, rawHorario);
                    toolResultStr = `¡Reserva cancelada con éxito! La cancha ${cancha} a las ${horario} el día ${dateIso} vuelve a estar libre.`;
                  } catch (e: any) {
                    toolResultStr = `ERROR al cancelar en Google Sheets: ${e.message}`;
                  }
                }
              }
            } else if (block.name === "aprobar_pago") {
              const { studentPhone, forgiveDebt, studentName, retroactiveDate } = block.input;

              const student = await dynamo.getStudent(tenantPhone, studentPhone);
              if (!student) {
                toolResultStr = `No se encontró ningún alumno con el teléfono "${studentPhone}".`;
              } else {
                let statusMsg = "";
                if (student.status !== 'ACTIVE') {
                   await dynamo.updateStudentStatusByPhone(tenantPhone, studentPhone, 'ACTIVE');
                   statusMsg += ` Además, el estado del alumno cambió automáticamente a ACTIVE.`;
                }
                if (studentName && studentName.trim() !== '' && student.name !== studentName) {
                   await dynamo.updateStudentNameByPhone(tenantPhone, studentPhone, studentName);
                   statusMsg += ` Además, se actualizó el nombre en la BD a "${studentName}".`;
                }

                const pendingPayment = await dynamo.getPendingPaymentForStudent(tenantPhone, studentPhone);
                if (!pendingPayment) {
                  const paymentAmount = student.planPrice || 0;
                  let paymentDate = new Date().toISOString();
                  if (retroactiveDate && !isNaN(Date.parse(retroactiveDate))) {
                    paymentDate = new Date(retroactiveDate).toISOString();
                  }
                  const manualPayment: Payment = {
                    PK: `TENANT#${tenantPhone}`,
                    SK: `PAYMENT#${paymentDate}#STUDENT#${studentPhone}`,
                    studentName: studentName || student.name,
                    studentPhone: studentPhone,
                    amount: paymentAmount,
                    calculatedMonths: 1,
                    method: 'CASH',
                    status: 'APPROVED',
                    createdAt: paymentDate
                  };
                  await dynamo.createPayment(manualPayment);
                  const forceResetDate = forgiveDebt ? new Date(paymentDate) : undefined;
                  await dynamo.advancePaidUntilDate(tenantPhone, studentPhone, paymentAmount, student.planPrice, student.paymentDay, forceResetDate);
                  toolResultStr = `No había comprobante pendiente, así que se registró un pago MANUAL exitoso de $${paymentAmount} para ${studentName || student.name}. Su fecha de vencimiento ha avanzado.${statusMsg}`;
                } else {
                  await dynamo.updatePaymentStatus(tenantPhone, pendingPayment.SK, 'APPROVED');

                  let paymentDate = new Date().toISOString();
                  if (retroactiveDate && !isNaN(Date.parse(retroactiveDate))) {
                    paymentDate = new Date(retroactiveDate).toISOString();
                  }

                  const forceResetDate = forgiveDebt ? new Date(paymentDate) : undefined;
                  await dynamo.advancePaidUntilDate(tenantPhone, studentPhone, pendingPayment.amount, student.planPrice, student.paymentDay, forceResetDate);

                  toolResultStr = `Se ha aprobado exitosamente el comprobante pendiente de $${pendingPayment.amount} para ${studentName || student.name}. Su fecha de vencimiento ha avanzado acorde al pago.${statusMsg}`;
                }

                if (tenant.crossHeroConfig?.enabled) {
                  const ch = new CrossHeroService(tenant.crossHeroConfig.boxId, tenant.crossHeroConfig.accessToken);
                  const cleanPhone = studentPhone.replace(/\D/g, '');
                  const chAthlete = await ch.getAthleteByPhone(cleanPhone);
                  if (chAthlete && chAthlete.id) {
                    const amountPaid = pendingPayment ? pendingPayment.amount : (student.planPrice || 0);
                    const paymentMethod = pendingPayment ? 'TRANSFER' : 'CASH';
                    const success = await ch.approvePayment(chAthlete.id, amountPaid, paymentMethod);
                    if (success) {
                      toolResultStr += " Pago sincronizado con CrossHero automáticamente.";
                    } else {
                      toolResultStr += " (Hubo un error interno al intentar registrar el pago en CrossHero).";
                    }
                  } else {
                    toolResultStr += " (Nota: El alumno no fue encontrado en CrossHero, por lo que su pago no se reflejó allá. Recuerda crearle su perfil).";
                  }
                }
              }
            } else if (block.name === "revertir_ultimo_pago") {
              const queryName = block.input.studentName;

              const students = await dynamo.findStudentsByName(tenantPhone, queryName);
              if (students.length === 0) {
                toolResultStr = `No se encontró ningún alumno con el nombre o fragmento "${queryName}".`;
              } else if (students.length > 1) {
                toolResultStr = `Se encontraron varios alumnos con el nombre "${queryName}". Por favor, pídele al administrador que sea más específico.`;
              } else {
                const student = students[0];
                const phoneParts = student.SK.split('#');
                const studentPhone = phoneParts.length > 1 ? phoneParts[1] : student.SK;

                const revertedPayment = await dynamo.revertLastPayment(tenantPhone, studentPhone);
                if (!revertedPayment) {
                  toolResultStr = `No se encontró ningún pago aprobado recientemente para ${student.name} que se pueda revertir.`;
                } else {
                  toolResultStr = `Se ha revertido exitosamente el pago de $${revertedPayment.amount}. A ${student.name} se le han restado ${revertedPayment.calculatedMonths} meses de su fecha de cobro.`;
                }
              }
            } else if (block.name === "eliminar_alumno") {
              const studentPhone = block.input.studentPhone;
              const success = await dynamo.deleteStudent(tenantPhone, studentPhone);
              if (success) {
                toolResultStr = `Se ha eliminado exitosamente al alumno con teléfono ${studentPhone} de la base de datos.`;
              } else {
                toolResultStr = `Hubo un error al intentar eliminar al alumno con teléfono ${studentPhone}.`;
              }
            } else if (block.name === "modificar_datos_alumno") {
              const { studentName, newPlanPrice, newPaymentDay, newName } = block.input;
              if (newPlanPrice === undefined && newPaymentDay === undefined && newName === undefined) {
                toolResultStr = "No se proporcionaron datos nuevos para actualizar.";
              } else {
                const success = await dynamo.updateStudentData(tenantPhone, studentName, {
                  planPrice: newPlanPrice,
                  paymentDay: newPaymentDay,
                  name: newName
                });
                if (success) {
                  toolResultStr = `Los datos de ${studentName} han sido actualizados exitosamente.`;
                } else {
                  toolResultStr = `No se encontró a ningún alumno con el nombre o fragmento "${studentName}".`;
                }
              }
            } else if (block.name === "gestionar_estado_alumno") {
              const { studentName, newStatus } = block.input;
              const success = await dynamo.updateStudentStatus(tenantPhone, studentName, newStatus);
              if (success) {
                toolResultStr = `El estado de ${studentName} ha sido actualizado a ${newStatus}.`;
              } else {
                toolResultStr = `No se pudo actualizar el estado. No se encontró a ningún alumno con el nombre o fragmento "${studentName}".`;
              }
            } else if (block.name === "migrar_numero_alumno") {
              const { telefono_antiguo, telefono_nuevo } = block.input;
              const success = await dynamo.migrateStudentPhone(tenantPhone, telefono_antiguo, telefono_nuevo);
              if (success) {
                toolResultStr = `El perfil del alumno ha sido migrado exitosamente del número ${telefono_antiguo} al número ${telefono_nuevo}.`;
              } else {
                toolResultStr = `Error: No se encontró ningún alumno registrado con el número antiguo ${telefono_antiguo}. Dile al usuario que verifique el número antiguo.`;
              }
            } else if (block.name === "registrar_nuevo_alumno") {
              const data = block.input;
              await dynamo.createStudentFromChat(tenantPhone, data);

              const creatorCoach = await dynamo.getCoach(tenantPhone, userPhone);
              if (creatorCoach) {
                await dynamo.assignCoachToStudent(tenantPhone, data.phone, userPhone);
              }

              let crossheroMsg = "";
              if (tenant.crossHeroConfig?.enabled) {
                const scraper = await getScraper(tenantPhone, tenant.crossHeroConfig);
                if (!scraper) throw new Error("Credenciales inválidas.");
                const success = await scraper.createAthlete({
                  name: data.name,
                  phone: data.phone,
                  email: data.email
                });
                crossheroMsg = success ? " También fue creado en CrossHero exitosamente." : " Hubo un problema al crearlo en CrossHero.";
              }

              toolResultStr = `Alumno ${data.name} registrado exitosamente. Si hasPaidInitial fue true, se registró su pago inicial.${crossheroMsg}`;
            } else if (block.name === "obtener_reporte_financiero") {
              const { yearMonth } = block.input;
              let targetMonth = yearMonth;
              if (!targetMonth) {
                const now = new Date();
                targetMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
              }
              const metrics = await dynamo.getFinancialMetrics(tenantPhone, targetMonth);
              toolResultStr = `Reporte Financiero para ${targetMonth}:\n` +
                              `- Total Recaudado: $${metrics.totalRecaudado}\n` +
                              `- Mensualidades Pagadas: ${metrics.mensualidadesPagadas}\n` +
                              `- Monto Pendiente por Cobrar (Deuda estimada de alumnos activos): $${metrics.deudaPendiente}`;
            } else if (block.name === "actualizar_precio_global") {
              const { newMonthlyFee } = block.input;
              const success = await dynamo.updateTenantMonthlyFee(tenantPhone, newMonthlyFee);
              if (success) {
                toolResultStr = `El precio base mensual de la academia ha sido actualizado a $${newMonthlyFee} exitosamente.`;
              } else {
                toolResultStr = `Error al actualizar el precio base en la base de datos.`;
              }
            } else if (block.name === "gestionar_horarios_clases") {
              const { newSchedules } = block.input;
              const success = await dynamo.updateTenantSchedules(tenantPhone, newSchedules);
              if (success) {
                toolResultStr = `Los horarios de clases han sido actualizados exitosamente en la configuración global de la academia.`;
              } else {
                toolResultStr = `Error al actualizar los horarios en la base de datos.`;
              }
            } else if (block.name === "leer_historial_alumno") {
              const { identificador_alumno } = block.input;
              let phone = identificador_alumno.replace(/\\D/g, '');
              let studentNameStr = "Desconocido";

              if (phone.length < 8) {
                const students = await dynamo.findStudentsByName(tenantPhone, identificador_alumno);
                if (!students || students.length === 0) {
                  toolResultStr = `No se encontró a ningún alumno con el nombre "${identificador_alumno}".`;
                } else if (students.length > 1) {
                  const names = students.map((s: any) => `${s.name} (${s.SK.split('#')[1]})`).join(', ');
                  toolResultStr = `Hay ${students.length} alumnos que coinciden: ${names}. Por favor especifica usando el número de teléfono o un nombre más exacto.`;
                } else {
                  phone = students[0].SK.split('#')[1];
                  studentNameStr = students[0].name;
                }
              }

              if (phone && phone.length >= 8 && !toolResultStr) {
                const history = await dynamo.getFullConversationHistory(tenantPhone, phone);
                if (history && history.length > 0) {
                  toolResultStr = `Historial de chat completo con el número ${phone} (${studentNameStr}):\n\n` +
                    history.map((msg: any) => `[${msg.role === 'user' ? 'Alumno' : 'Bot'}]: ${msg.content}`).join('\n\n');
                } else {
                  toolResultStr = `No hay historial de conversación registrado con el número ${phone}.`;
                }
              }
            } else if (block.name === "obtener_conversaciones_recientes") {
              const recent = await dynamo.getRecentConversations(tenantPhone, 24);
              if (recent.length === 0) {
                toolResultStr = "No se registran conversaciones en las últimas 24 horas.";
              } else {
                toolResultStr = `Se encontraron conversaciones con ${recent.length} personas distintas en las últimas 24 horas:\n\n`;
                for (const conv of recent) {
                  const students = await dynamo.findStudentsByName(tenantPhone, conv.phone);
                  const name = students.length > 0 ? students[0].name : "Prospecto/Desconocido";
                  toolResultStr += `=== Chat con ${name} (${conv.phone}) ===\n`;
                  toolResultStr += `Última interacción: ${conv.lastMessageAt.toLocaleString('es-CL')}\n`;
                  const lastMessages = conv.messages.slice(-4);
                  toolResultStr += lastMessages.map((msg: any) => `[${msg.role === 'user' ? 'Alumno' : 'Bot'}]: ${msg.content}`).join('\n');
                  toolResultStr += `\n\n`;
                }
                toolResultStr += `Fin del reporte. Puedes usar 'leer_historial_alumno' si necesitas leer un chat completo específico.`;
              }
                        } else if (block.name === "buscar_alumno_en_crosshero") {
              const { nameQuery } = block.input;
              if (!tenant.crossHeroConfig?.enabled) {
                toolResultStr = "CrossHero no está habilitado para esta academia.";
              } else {
                const ch = new CrossHeroService(tenant.crossHeroConfig.boxId, tenant.crossHeroConfig.accessToken);
                const athletes = await ch.findAthleteByName(nameQuery);
                if (athletes.length === 0) {
                  toolResultStr = "No se encontraron atletas con ese nombre en CrossHero.";
                } else {
                  toolResultStr = "Atletas encontrados:\n" + athletes.map((a: any) => `- ID: ${a.id} | Nombre: ${a.first_name} ${a.last_name} | Email: ${a.email}`).join('\n');
                }
              }
            } else if (block.name === "aprobar_pago_crosshero") {
              let { athleteId, amount, method } = block.input;
              if (!tenant.crossHeroConfig?.enabled) {
                toolResultStr = "CrossHero no está habilitado para esta academia.";
              } else {
                const ch = new CrossHeroService(tenant.crossHeroConfig.boxId, tenant.crossHeroConfig.accessToken);

                let resolvedId = athleteId;
                if (athleteId.includes(" ") || !/^[0-9a-fA-F-]+$/.test(athleteId)) {
                    console.log("Auto-resolviendo ID de atleta desde el nombre: " + athleteId);
                    const athletes = await ch.findAthleteByName(athleteId);
                    if (athletes.length > 0) {
                        resolvedId = athletes[0].id;
                    }
                }

                const success = await ch.approvePayment(resolvedId, amount, method);
                if (success) {
                  toolResultStr = "Pago registrado y aprobado exitosamente en CrossHero.";
                } else {
                  toolResultStr = "Hubo un error al registrar el pago en CrossHero (posible ID no encontrado). Pide al administrador que revise la app.";
                }
              }
            } else {
              toolResultStr = `Herramienta ${block.name} no implementada.`;
            }
        } catch (e: any) {
          toolResultStr = "ERROR: " + e.message;
        }
        toolResultContent.push({ toolResult: { toolUseId: block.toolUseId, content: [{ text: toolResultStr }] } });
      }
      mappedMessages.push({ role: "user", content: toolResultContent });
    } else {
      keepRunning = false;
    }
  }

  const updatedHistory = mappedMessages.map((msg: any) => {
    if (msg.role === "user" || msg.role === "assistant") {
      let anthropicContent = [];
      for (const c of msg.content) {
         if (c.text) anthropicContent.push({ type: "text", text: c.text });
         if (c.toolUse) anthropicContent.push({ type: "tool_use", id: c.toolUse.toolUseId, name: c.toolUse.name, input: c.toolUse.input });
         if (c.toolResult) anthropicContent.push({ type: "tool_result", tool_use_id: c.toolResult.toolUseId, content: c.toolResult.content[0].text });
      }
      return { role: msg.role, content: anthropicContent };
    }
    return msg;
  });

  return { text: finalResponseText, history: updatedHistory };
}
