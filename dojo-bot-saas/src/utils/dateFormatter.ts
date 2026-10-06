export function parseIsoToExcelFormat(dateIso: string): string {
    const [year, month, day] = dateIso.split('-');

    // Noon UTC keeps the calendar day unchanged when rendered in America/Santiago, regardless of DST.
    const dateObj = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), 12, 0, 0));

    const formatter = new Intl.DateTimeFormat('es-CL', {
        weekday: 'short',
        timeZone: 'America/Santiago'
    });

    let weekdayStr = formatter.format(dateObj).toLowerCase();

    weekdayStr = weekdayStr.replace('.', '');

    return `${weekdayStr} ${day}.${month}`;
}

export function validateDateBooking(dateIso: string, maxAdvanceDays: number = 30): { valid: boolean, error?: string } {
    const regex = /^\d{4}-\d{2}-\d{2}$/;
    if (!regex.test(dateIso)) {
        return { valid: false, error: 'La fecha no tiene el formato correcto (YYYY-MM-DD).' };
    }

    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Santiago',
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = formatter.formatToParts(now);
    const mm = parts.find(p => p.type === 'month')?.value;
    const dd = parts.find(p => p.type === 'day')?.value;
    const yyyy = parts.find(p => p.type === 'year')?.value;

    const santiagoToday = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);

    const targetDate = new Date(`${dateIso}T00:00:00Z`);

    if (targetDate.getTime() < santiagoToday.getTime()) {
        return { valid: false, error: 'No puedes reservar canchas en fechas pasadas.' };
    }

    const maxFutureDate = new Date(santiagoToday.getTime() + maxAdvanceDays * 24 * 60 * 60 * 1000);
    if (targetDate.getTime() > maxFutureDate.getTime()) {
        return { valid: false, error: `No puedes reservar con más de ${maxAdvanceDays} días de anticipación.` };
    }

    return { valid: true };
}
