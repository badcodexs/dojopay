export interface CourtAvailableBlock {
    cancha: string;
    horario: string;
    rowIndex?: number;
}

export async function getAvailableCourts(appsScriptUrl: string, formattedDateStr: string): Promise<CourtAvailableBlock[]> {
    try {
        const response = await fetch(appsScriptUrl, {
            method: 'POST',
            body: JSON.stringify({
                action: 'GET_AVAILABLE',
                dateTab: formattedDateStr
            }),
            headers: { 'Content-Type': 'application/json' }
        });

        const text = await response.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            throw new Error(`Invalid JSON from Apps Script: ${text}`);
        }

        if (!result.success) {
            throw new Error(result.error || 'Unknown Apps Script Error');
        }

        return result.data || [];
    } catch (error: any) {
        throw error;
    }
}

export async function bookCourt(
    appsScriptUrl: string,
    formattedDateStr: string,
    cancha: string,
    horario: string,
    userName: string,
    abonoAmount: number
): Promise<boolean> {
    try {
        const response = await fetch(appsScriptUrl, {
            method: 'POST',
            body: JSON.stringify({
                action: 'BOOK',
                dateTab: formattedDateStr,
                cancha: cancha,
                horario: horario,
                studentName: userName,
                abono: abonoAmount
            }),
            headers: { 'Content-Type': 'application/json' }
        });

        const text = await response.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            throw new Error(`Invalid JSON from Apps Script: ${text}`);
        }

        if (!result.success) {
            if (result.error === 'OCCUPIED') throw new Error('OCCUPIED');
            throw new Error(result.error || 'Unknown Apps Script Error');
        }

        return true;
    } catch (error: any) {
        throw error;
    }
}

export interface CourtStatusBlock {
    cancha: string;
    horario: string;
    estado: string;
    nombre: string;
    abono: number;
    porPagar: number;
    total: number;
}

export async function getAllCourts(appsScriptUrl: string, formattedDateStr: string): Promise<CourtStatusBlock[]> {
    try {
        const response = await fetch(appsScriptUrl, {
            method: 'POST',
            body: JSON.stringify({
                action: 'GET_ALL',
                dateTab: formattedDateStr
            }),
            headers: { 'Content-Type': 'application/json' }
        });

        const text = await response.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            throw new Error(`Invalid JSON from Apps Script: ${text}`);
        }

        if (!result.success) {
            throw new Error(result.error || 'Unknown Apps Script Error');
        }

        return result.data || [];
    } catch (error: any) {
        throw error;
    }
}

export async function cancelCourtBooking(
    appsScriptUrl: string,
    formattedDateStr: string,
    cancha: string,
    horario: string
): Promise<boolean> {
    try {
        const response = await fetch(appsScriptUrl, {
            method: 'POST',
            body: JSON.stringify({
                action: 'CANCEL_BOOKING',
                dateTab: formattedDateStr,
                cancha: cancha,
                horario: horario
            }),
            headers: { 'Content-Type': 'application/json' }
        });

        const text = await response.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            throw new Error(`Invalid JSON from Apps Script: ${text}`);
        }

        if (!result.success) {
            throw new Error(result.error || 'Unknown Apps Script Error');
        }

        return true;
    } catch (error: any) {
        throw error;
    }
}
