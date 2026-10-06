import ExcelJS from 'exceljs';
import { Student } from './dynamodb';

export async function generateStudentsExcelBuffer(students: Student[], coachMap?: Map<string, string>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DojoBot SaaS';
  workbook.created = new Date();
  workbook.modified = new Date();

  const worksheet = workbook.addWorksheet('Alumnos', {
    properties: { tabColor: { argb: 'FFC0000' } }
  });

  worksheet.columns = [
    { header: 'Nombre', key: 'name', width: 25 },
    { header: 'Teléfono', key: 'phone', width: 20 },
    { header: 'Estado', key: 'status', width: 15 },
    { header: 'Día de Pago', key: 'paymentDay', width: 15 },
    { header: 'Cuota', key: 'planPrice', width: 15 },
    { header: 'Fecha de Cobertura (Paid Until)', key: 'paidUntilDate', width: 25 },
    { header: 'Fecha Ingreso', key: 'createdAt', width: 25 },
    { header: 'Profesor Asignado', key: 'assignedCoach', width: 25 },
  ];

  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4F81BD' }
  };

  for (const s of students) {
    const phoneParts = s.SK.split('#');
    const phone = phoneParts.length > 1 ? phoneParts[1] : s.SK;

    let coachName = "Sin Profesor";
    if (s.assignedCoaches && s.assignedCoaches.length > 0) {
      coachName = s.assignedCoaches.map(c => (coachMap && coachMap.get(c)) || c.replace('COACH#', '')).join(', ');
    } else if (s.assignedCoach) {
      coachName = (coachMap && coachMap.get(s.assignedCoach)) || s.assignedCoach.replace('COACH#', '');
    }

    worksheet.addRow({
      name: s.name,
      phone,
      status: s.status,
      paymentDay: s.paymentDay,
      planPrice: s.planPrice || 0,
      paidUntilDate: s.paidUntilDate ? s.paidUntilDate.split('T')[0] : 'N/A',
      createdAt: s.createdAt ? (typeof s.createdAt === 'string' ? s.createdAt.split('T')[0] : new Date(s.createdAt).toISOString().split('T')[0]) : 'Desconocida',
      assignedCoach: coachName
    });
  }

  worksheet.views = [
    { state: 'frozen', xSplit: 0, ySplit: 1 }
  ];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
};
