import { SQSEvent } from 'aws-lambda';
import { dynamo } from '../services/dynamodb';
import { whatsapp } from '../services/whatsapp';
import { invokeClaudeHaiku } from '../services/ai';
import { invokeNovaLite } from '../services/ai-nova';
import { transcribeAudio } from '../services/transcribe';
import { isSalesTenant } from '../utils/salesTenants';
import { getLegacyPrompt, buildDynamicPrompt, buildSalesAgentPrompt, buildCourtAgentPrompt, buildAdminPrompt, buildCoachPrompt, buildHistoryContext } from '../agent/system-prompts';

export const handler = async (event: SQSEvent): Promise<void> => {
  try {
    for (const record of event.Records) {
      const rawBody = record.body;
      console.log("RAW BODY:", rawBody);
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch (parseError: any) {
        console.error('Invalid JSON payload received in SQS:', rawBody);
        continue;
      }

      // Evolution API webhooks are normalized into the Meta Cloud API shape so a single pipeline handles both providers.
      const isSelfMessage = body.data?.key?.fromMe && body.data?.key?.remoteJid?.includes(body.instance);
      if (body.event === 'messages.upsert' && body.data && (!body.data.key.fromMe || isSelfMessage)) {
        const jid = body.data.key.remoteJid || '';
        if (jid.includes('@g.us') || jid.includes('@status')) continue;

        const from = jid.split('@')[0];
        const msgId = body.data.key.id;

        let type = 'text';
        let text = '';
        let messageObj: any = { id: msgId, from: from };

        if (body.data.message?.conversation || body.data.message?.extendedTextMessage?.text) {
          type = 'text';
          text = body.data.message.conversation || body.data.message.extendedTextMessage?.text || '';
          messageObj.type = 'text';
          messageObj.text = { body: text };
        } else if (body.data.message?.audioMessage) {
          type = 'audio';
          messageObj.type = 'audio';
          messageObj.audio = { id: 'evolution_audio', mime_type: body.data.message.audioMessage.mimetype, evolutionMessage: body.data };
        } else if (body.data.message?.imageMessage) {
          type = 'image';
          messageObj.type = 'image';
          messageObj.image = { id: 'evolution_image', mime_type: body.data.message.imageMessage.mimetype, evolutionMessage: body.data };
        } else {
          type = 'unknown';
        }

        body.entry = [{
          changes: [{
            value: {
              metadata: {
                phone_number_id: body.instance,
                display_phone_number: body.instance
              },
              messages: [messageObj]
            }
          }]
        }];
      }

      const entries = body.entry || [];

    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.value && change.value.messages) {
          const message = change.value.messages[0];
          const metadata = change.value.metadata;

          if (await dynamo.hasMessageBeenProcessed(message.id)) {
            console.log(`Idempotency: Message ${message.id} already processed. Skipping.`);
            continue;
          }
          await dynamo.saveMessageId(message.id);

          const tenantPhone = metadata.display_phone_number;
          const phoneNumberId = metadata.phone_number_id;
          const fromPhone = message.from;
          let messageType = message.type;
          const profileName = change.value.contacts?.[0]?.profile?.name || '';

          console.log(`Received ${messageType} message from ${fromPhone} (${profileName}) to ${tenantPhone}`);

          const tenant = await dynamo.getTenant(tenantPhone);
          if (!tenant) {
            console.error(`Tenant not found for phone: ${tenantPhone}`);
            continue;
          }
          if (tenant.status === 'INACTIVE') {
            console.log(`Tenant ${tenantPhone} is INACTIVE. Ignoring message.`);
            continue;
          }

          let role = 'STUDENT';
          const cleanFromPhone = fromPhone.replace(/\D/g, '');
          const adminPhones = (tenant.adminPhones || (tenant.adminPhone ? [tenant.adminPhone] : [])).map((p: string) => p.replace(/\D/g, ''));
          const coachData = await dynamo.getCoach(tenantPhone, fromPhone);
          const isAlsoCoach = !!coachData;

          if (adminPhones.includes(cleanFromPhone)) {
            role = 'ADMIN';
          } else if (isAlsoCoach) {
            role = 'COACH';
          }

          console.log(`Sender role identified as: ${role}`);

          let finalStudentName = profileName;
          let currentStudentInfo = null;
          if (role === 'STUDENT') {
            const student = await dynamo.getStudent(tenantPhone, fromPhone);
            if (student) {
              currentStudentInfo = student;
              const currentName = student.name || '';
              const isGenericName = currentName === 'Desconocido' ||
                                    currentName.startsWith('Alumno Importado') ||
                                    currentName.startsWith('Alumno Radical') ||
                                    currentName.trim() === '';

              if (!isGenericName && currentName.trim() !== '') {
                finalStudentName = currentName;
              } else {
                finalStudentName = currentName;
              }
            }
          }

          if (messageType === 'text' && role === 'ADMIN' && message.text?.body?.startsWith('/')) {
          let textContent = message.text.body;
          const currentCount = await dynamo.addPendingMessage(tenantPhone, fromPhone, textContent);

          // Debounce: wait for rapid-fire messages; only the last concurrent invocation answers, with all of them aggregated.
          await new Promise(resolve => setTimeout(resolve, 3000));

          const newCount = await dynamo.getPendingMessagesCount(tenantPhone, fromPhone);
          if (newCount > currentCount) {
             console.log(`Debounce: Another message arrived for ${fromPhone}. Aborting this execution.`);
             return;
          }

          const allMessages = await dynamo.clearAndGetPendingMessages(tenantPhone, fromPhone);
          if (allMessages.length === 0) return;

          textContent = allMessages.join('\n');
          console.log(`Aggregated messages: ${textContent}`);

            const parts = textContent.trim().split(' ');
            const command = parts[0].toLowerCase();
            const targetPhone = parts.length > 1 ? parts[1].replace(/[^0-9]/g, '') : null;

            if ((command === '/pausar' || command === '/pausa') && targetPhone) {
              await dynamo.setChatPauseState(tenantPhone, targetPhone, true);
              await whatsapp.sendMessage(phoneNumberId, fromPhone, `✅ Bot pausado para el cliente ${targetPhone}. Ahora tienes el control manual de ese chat.`, tenant);
              continue;
            } else if ((command === '/reanudar' || command === '/activar') && targetPhone) {
              await dynamo.setChatPauseState(tenantPhone, targetPhone, false);
              await whatsapp.sendMessage(phoneNumberId, fromPhone, `▶️ Bot reactivado para el cliente ${targetPhone}. Volveré a responderle.`, tenant);
              continue;
            }
          }

          if (tenant.pausedChats && tenant.pausedChats.includes(fromPhone)) {
            console.log(`Mensaje de ${fromPhone} ignorado. El chat está pausado por el Admin.`);
            continue;
          }

          if (messageType === 'image') {
            console.log('Image received, running automated accounting analysis...');

            try {
                const mediaId = message.image.id;
                const mimeType = message.image.mime_type;
                const url = await whatsapp.getMediaUrl(mediaId, tenant);
                const imageBytes = await whatsapp.downloadMedia(url, tenant);
                const base64Image = Buffer.from(imageBytes).toString('base64');

                let analysis;
                const visionPrompt = `Eres un auditor contable automatizado. Analiza la imagen adjunta. 
Si no es un comprobante de pago o transferencia bancaria (ej. es un meme, selfie, foto irrelevante o ilegible), indica que no es válido.
Si es un comprobante de pago válido, extrae el monto transferido (solo números) y el banco de origen.
Tu respuesta DEBE ser ÚNICAMENTE un objeto JSON válido, sin texto adicional, sin bloques de código markdown, estrictamente formateado así:
{ "isValidReceipt": boolean, "amount": number, "bank": string, "reason": string }`;

                const aiResponse = await invokeClaudeHaiku(visionPrompt, [], "Analiza este comprobante.", tenant, fromPhone, phoneNumberId, role, { base64: base64Image, mimeType: mimeType });

                try {
                    let jsonText = aiResponse.text.trim();
                    if (jsonText.startsWith('```json')) jsonText = jsonText.slice(7, -3);
                    else if (jsonText.startsWith('```')) jsonText = jsonText.slice(3, -3);
                    analysis = JSON.parse(jsonText);
                } catch (e) {
                    console.error("Failed to parse JSON from AI:", aiResponse.text);
                    throw new Error("Invalid AI JSON output");
                }

                if (role === 'ADMIN') {
                    const bankInfo = analysis.bank ? ` desde ${analysis.bank}` : '';
                    if (analysis.isValidReceipt) {
                      messageType = 'text';
                      message.text = { body: `[SISTEMA INTERNO: El dueño acaba de enviar una foto de un comprobante de pago válido por $${analysis.amount}${bankInfo}. Tu trabajo es ayudarlo a registrar este pago. Usa 'buscar_alumno_por_nombre' si necesitas encontrar al alumno por su nombre, y luego 'aprobar_pago' para aprobar el pago. Si no sabes a nombre de quién es, pregúntale cordialmente al dueño.]` };
                    } else {
                      messageType = 'text';
                      message.text = { body: `[SISTEMA INTERNO: El dueño envió una imagen que no parece ser un comprobante de pago. Observación del análisis: ${analysis.reason}. Respóndele naturalmente y pregúntale en qué le puedes ayudar.]` };
                    }
                } else if (!analysis.isValidReceipt) {
                    await whatsapp.sendMessage(phoneNumberId, fromPhone, `Lo siento, esta imagen no parece un comprobante válido. Observación: ${analysis.reason}`, tenant);
                    continue;
                } else if (tenant.googleSheetsConfig?.enabled) {
                    const bankInfo = analysis.bank ? ` desde ${analysis.bank}` : '';
                    messageType = 'text';
                    message.text = { body: `[SISTEMA INTERNO: El usuario acaba de subir un comprobante bancario válido por un monto de $${analysis.amount}${bankInfo}. Si estaba en proceso de reserva, ejecuta PRIMERO 'cancelar_reserva_cancha' y LUEGO 'reservar_cancha' con este monto (${analysis.amount}).]` };
                } else {
                    const student = await dynamo.getStudent(tenantPhone, fromPhone);
                    const planPrice = student && student.planPrice > 0 ? student.planPrice : 1;
                    const calculatedMonths = analysis.amount ? (analysis.amount / planPrice) : 0;
                    const roundedMonths = parseFloat(calculatedMonths.toFixed(2));

                    await dynamo.createPayment({
                      PK: `TENANT#${tenantPhone}`,
                      SK: `PAYMENT#${new Date().toISOString()}#STUDENT#${fromPhone}`,
                      studentName: student ? student.name : 'Desconocido',
                      studentPhone: fromPhone,
                      amount: analysis.amount || 0,
                      calculatedMonths: roundedMonths,
                      method: 'TRANSFER',
                      status: 'PENDING',
                      receiptUrl: mediaId,
                      createdAt: new Date().toISOString()
                    });

                    const bankInfo = analysis.bank ? ` desde ${analysis.bank}` : '';
                    await whatsapp.sendMessage(phoneNumberId, fromPhone, `✅ Comprobante registrado exitosamente por un monto de $${analysis.amount}${bankInfo} (equivalente a ${roundedMonths} meses). Queda en espera de revisión final por el Sensei.`, tenant);
                    continue;
                }
            } catch (error) {
                console.error("Error processing image:", error);
                await whatsapp.sendMessage(phoneNumberId, fromPhone, "Lo siento, tuve un problema leyendo tu comprobante. Asegúrate de que la foto sea clara o inténtalo más tarde.", tenant);
            }
            continue;
          }

          if (messageType === 'text') {
          let textContent = message.text.body;
          const currentCount = await dynamo.addPendingMessage(tenantPhone, fromPhone, textContent);

          // Debounce: wait for rapid-fire messages; only the last concurrent invocation answers, with all of them aggregated.
          await new Promise(resolve => setTimeout(resolve, 3000));

          const newCount = await dynamo.getPendingMessagesCount(tenantPhone, fromPhone);
          if (newCount > currentCount) {
             console.log(`Debounce: Another message arrived for ${fromPhone}. Aborting this execution.`);
             return;
          }

          const allMessages = await dynamo.clearAndGetPendingMessages(tenantPhone, fromPhone);
          if (allMessages.length === 0) return;

          textContent = allMessages.join('\n');
          console.log(`Aggregated messages: ${textContent}`);

            let systemPrompt = '';
            if (isSalesTenant(tenantPhone)) {
              systemPrompt = buildSalesAgentPrompt();
            } else {
              if (tenant.googleSheetsConfig?.enabled) {
                systemPrompt = buildCourtAgentPrompt(tenant);
              } else if (role === 'ADMIN') {
                systemPrompt = buildAdminPrompt(tenant, isAlsoCoach);
              } else if (role === 'COACH') {
                systemPrompt = buildCoachPrompt(tenant);
              } else if (tenant.aiConfig?.customPromptVersion === 'v2') {
                systemPrompt = buildDynamicPrompt(tenant, tenantPhone);
              } else {
                systemPrompt = getLegacyPrompt(tenant, tenantPhone);
              }
            }
            console.log(`Invoking Claude Haiku for ${role}...`);

            try {
              const history = await dynamo.getConversationHistory(tenantPhone, fromPhone);

              const historyContext = buildHistoryContext(tenantPhone, fromPhone, role, finalStudentName || '', currentStudentInfo);

              const aiResponse = (role === "ADMIN" || role === "COACH" || isSalesTenant(tenantPhone)) ? await invokeClaudeHaiku(systemPrompt + "\n" + historyContext, history, textContent, tenant, fromPhone, phoneNumberId, role) : await invokeNovaLite(systemPrompt + "\n" + historyContext, history, textContent, tenant, fromPhone, phoneNumberId, role);

              const replyText = aiResponse.text || "¡Listo! Tu solicitud fue procesada.";

              let visibleReply = replyText.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
              visibleReply = visibleReply.replace(/\n?\[CLASES_DISPONIBLES:[^\]]*\]/g, '').trim();

              if (!visibleReply) visibleReply = "¿Podrías darme más detalles?"; await whatsapp.sendMessage(phoneNumberId, fromPhone, visibleReply, tenant);
              await dynamo.saveFullConversationHistory(tenantPhone, fromPhone, aiResponse.history);
            } catch (error) {
              console.error('Error invocando IA:', (error as any).response ? JSON.stringify((error as any).response.data) : error);
              await whatsapp.sendMessage(phoneNumberId, fromPhone, "Lo siento, mi cerebro artificial está teniendo un pequeño fallo. Intenta más tarde.", tenant);
            }
          } else if (messageType === 'audio') {
            console.log('Audio received, downloading and invoking Transcribe Streaming...');
            console.log("DEBUG message:", JSON.stringify(message, null, 2));
            console.log("DEBUG tenant provider:", tenant.provider);

            const mediaId = message.audio.id;
            let audioBytes: any;
            try {
              if (tenant.provider === 'EVOLUTION' && message.audio.evolutionMessage) {
                 audioBytes = await whatsapp.downloadEvolutionMedia(tenant.evolutionInstanceName!, message.audio.evolutionMessage);
              } else {
                 const url = message.audio.url;
                 console.log("Using Media URL from payload:", url);
                 audioBytes = await whatsapp.downloadMedia(url, tenant);
              }
            } catch (err: any) {
              console.error("Error downloading media:", err.response?.data || err.message);
              await whatsapp.sendMessage(phoneNumberId, fromPhone, "Lo siento, no pude descargar tu audio debido a un error de red.", tenant);
              continue;
            }

            let systemPrompt = '';
            if (role === 'ADMIN') {
              systemPrompt = buildAdminPrompt(tenant, isAlsoCoach);
            } else if (role === 'COACH') {
              systemPrompt = buildCoachPrompt(tenant);
            } else {
              if (tenant.aiConfig?.customPromptVersion === 'v2') {
                systemPrompt = buildDynamicPrompt(tenant, tenantPhone);
              } else {
                systemPrompt = getLegacyPrompt(tenant, tenantPhone);
              }
            }

            try {
              console.log('Audio downloaded, starting transcription...');
              const textContent = await transcribeAudio(audioBytes);
              console.log(`Transcribed text: "${textContent}"`);

              if (!textContent) {
                await whatsapp.sendMessage(phoneNumberId, fromPhone, "Lo siento, no pude entender el audio.", tenant);
                continue;
              }

              const history = await dynamo.getConversationHistory(tenantPhone, fromPhone);
              const historyContext = buildHistoryContext(tenantPhone, fromPhone, role, finalStudentName || '', currentStudentInfo);
              const aiResponse = (role === "ADMIN" || role === "COACH" || isSalesTenant(tenantPhone)) ? await invokeClaudeHaiku(systemPrompt + "\n" + historyContext, history, textContent, tenant, fromPhone, phoneNumberId, role) : await invokeNovaLite(systemPrompt + "\n" + historyContext, history, textContent, tenant, fromPhone, phoneNumberId, role);
              let replyText = aiResponse.text || "¡Listo! Tu solicitud fue procesada.";
              replyText = replyText.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();

              if (!replyText) replyText = "¿Podrías darme más detalles?"; await whatsapp.sendMessage(phoneNumberId, fromPhone, replyText, tenant);
              await dynamo.saveFullConversationHistory(tenantPhone, fromPhone, aiResponse.history);
            } catch (error) {
              console.error('Error procesando audio con Transcribe:', error);
              await whatsapp.sendMessage(phoneNumberId, fromPhone, "Lo siento, el sistema de reconocimiento de voz está fallando. ¿Puedes escribirlo?", tenant);
            }
          } else {
             console.log(`Unsupported message type: ${messageType}`);
          }
        }
      }
    }
    }
    return;
  } catch (error: any) {
    console.error('CRITICAL Error processing worker message:', error);
    throw error;
  }
};
