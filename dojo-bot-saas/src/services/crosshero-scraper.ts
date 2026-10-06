import axios from 'axios';
import * as cheerio from 'cheerio';
import { dynamo } from './dynamodb';

export class CrossHeroScraper {
  private tenantPhone: string;
  private email: string;
  private pass: string;
  private sessionCookie: string | null = null;

  constructor(tenantPhone: string, email: string, pass: string) {
    this.tenantPhone = tenantPhone;
    this.email = email;
    this.pass = pass;
  }

  public async getSession(): Promise<string> {
    const tenant = await dynamo.getTenant(this.tenantPhone);
    if (!tenant) throw new Error("Tenant no encontrado");

    if (tenant.crossHeroConfig && tenant.crossHeroConfig.sessionCookie) {
      this.sessionCookie = tenant.crossHeroConfig.sessionCookie;
      return this.sessionCookie;
    }

    console.log(`[Scraper] Iniciando sesión real en CrossHero para ${this.email}...`);
    const cookie = await this.performLogin();

    const updatedConfig = {
      ...(tenant.crossHeroConfig || {}),
      sessionCookie: cookie
    };
    await dynamo.updateTenantCrossHeroConfig(this.tenantPhone, updatedConfig);

    this.sessionCookie = cookie;
    return cookie;
  }

  private async performLogin(): Promise<string> {
    const getRes = await axios.get('https://crosshero.com/athletes/sign_in');

    const setCookieHeader = getRes.headers['set-cookie'];
    const initialCookies = setCookieHeader ? setCookieHeader.map((c: string) => c.split(';')[0]).join('; ') : '';
    const html = getRes.data;

    const tokenMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (!tokenMatch) throw new Error("No se pudo encontrar el Token CSRF de CrossHero.");
    const token = tokenMatch[1];

    const loginData = new URLSearchParams();
    loginData.append('authenticity_token', token);
    loginData.append('athlete[email]', this.email);
    loginData.append('athlete[password]', this.pass);
    loginData.append('athlete[remember_me]', '0');
    loginData.append('commit', 'Iniciar Sesión');

    const loginRes = await axios.post('https://crosshero.com/athletes/sign_in', loginData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': initialCookies,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      },
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400
    });

    const newCookies = loginRes.headers['set-cookie'];
    if (!newCookies) throw new Error("Credenciales inválidas o inicio de sesión fallido en CrossHero.");

    const sessionCookieStr = newCookies.find((c: string) => c.includes('_crosshero_session'));
    if (!sessionCookieStr) throw new Error("No se recibió la cookie _crosshero_session de CrossHero.");

    return sessionCookieStr.split(';')[0];
  }

  private async getPlansMap(): Promise<Map<string, number>> {
    const cookie = await this.getSession();
    const res = await axios.get('https://crosshero.com/dashboard/admin/plans', {
      headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' },
      validateStatus: status => status >= 200 && status < 400
    });
    if (res.status === 302) return new Map();
    const $ = cheerio.load(res.data);
    const plans = new Map<string, number>();
    $('table tbody tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const name = $(cells[0]).text().trim().split('\n')[0].trim();
        const priceStr = $(cells[1]).text().trim();
        if (name && priceStr.startsWith('$')) {
          const price = parseInt(priceStr.replace(/[^0-9]/g, ''), 10);
          if (!isNaN(price)) {
            plans.set(name.toLowerCase(), price);
          }
        }
      }
    });
    return plans;
  }

  public async getBillingData(): Promise<any[]> {
    const cookie = await this.getSession();
    console.log("[Scraper] Obteniendo lista de facturación (memberships)...");
    const athletes: any[] = [];
    const plansMap = await this.getPlansMap();
    console.log(`[Scraper] Obtenidos ${plansMap.size} planes para mapear precios.`);
    let currentPage = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      console.log(`[Scraper] Obteniendo página ${currentPage}...`);
      const adminRes = await axios.get(`https://crosshero.com/dashboard/admin/memberships?filter%5Bstatus%5D=active&page=${currentPage}`, {
        headers: {
          'Cookie': cookie,
          'User-Agent': 'Mozilla/5.0'
        },
        validateStatus: status => status >= 200 && status < 400
      });

      if (adminRes.status === 302) {
         console.log("[Scraper] Cookie expirada, re-autenticando...");
         const tenant = await dynamo.getTenant(this.tenantPhone);
         if (!tenant?.crossHeroConfig?.adminEmail || !tenant?.crossHeroConfig?.adminPass) {
           throw new Error("No hay credenciales guardadas para re-autenticar");
         }
         this.sessionCookie = null; await this.getSession();
         return this.getBillingData();
      }

      const $ = cheerio.load(adminRes.data);

      $('table tbody tr').each((i, row) => {
        const cells = $(row).find('td');
        if (cells.length < 7) return;

        const name = $(cells[0]).text().trim();
        const href = $(cells[0]).find("a").attr("href") || "";
        const idMatch = href.match(/athletes\/([^\/]+)/);
        const id = idMatch ? idMatch[1] : undefined;

                const dueDateStr = $(cells[5]).text().trim();
        const statusText = $(cells[6]).text().trim().toLowerCase();
        const cuota = $(cells[2]).text().trim().toLowerCase();
        const planPrice = plansMap.get(cuota);

        if (name && statusText.includes('activo')) {
          athletes.push({ name, dueDateStr, id, planPrice });
        }
      });

      const nextLink = $('ul.pagination li a[rel="next"]');
      if (nextLink.length > 0) {
        currentPage++;
      } else {
        hasNextPage = false;
      }
    }

    return athletes;
  }

  public async getAvailableClasses(dateStr: string, programName: string = ""): Promise<any[]> {
    const cookie = await this.getSession();

    const encodedDate = encodeURIComponent(dateStr);
    const mainRes = await axios.get(`https://crosshero.com/dashboard/classes?date=${encodedDate}`, {
      headers: { 'Cookie': cookie }
    });
    let $ = cheerio.load(mainRes.data);

    let programsToFetch: {id: string, name: string}[] = [];
    $('#class_program_id option').each((i, el) => {
      const val = $(el).attr('value');
      const name = $(el).text().trim();
      if (val) {
        if (!programName || name.toLowerCase().includes(programName.toLowerCase())) {
          programsToFetch.push({ id: val, name });
        }
      }
    });

    if (programsToFetch.length === 0) {
      if (programName) throw new Error(`Programa '${programName}' no encontrado.`);
      return [];
    }

    const allClasses: any[] = [];
    for (const prog of programsToFetch) {
      const programRes = await axios.get(`https://crosshero.com/dashboard/classes?date=${encodedDate}&program_id=${prog.id}`, {
        headers: { 'Cookie': cookie }
      });
      const $p = cheerio.load(programRes.data);

      $p('#class_reservation_single_class_id option').each((i, el) => {
        const val = $p(el).attr('value');
        const time = $p(el).text().trim();
        if (val && time) {
          allClasses.push({ singleClassId: val, time, program: prog.name });
        }
      });
    }

    return allClasses;
  }

  public async bookClass(dateStr: string, singleClassId: string, athleteId: string): Promise<boolean> {
    const cookie = await this.getSession();

    const encodedDate = encodeURIComponent(dateStr);
    const getRes = await axios.get(`https://crosshero.com/dashboard/classes?date=${encodedDate}`, {
      headers: { 'Cookie': cookie }
    });
    const html = getRes.data;
    const tokenMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (!tokenMatch) throw new Error("No se pudo encontrar el Token CSRF para reservar.");
    const token = tokenMatch[1];

    const postData = new URLSearchParams();
    postData.append('authenticity_token', token);
    postData.append('class_reservation[athlete_id]', athleteId);
    postData.append('class_reservation[single_class_id]', singleClassId);

    const postRes = await axios.post('https://crosshero.com/dashboard/class_reservations', postData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      },
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400
    });

    const $res = cheerio.load(postRes.data);
    const alertText = $res('.alert').text().trim();

    if (alertText && !alertText.toLowerCase().includes('éxito')) {
      throw new Error(alertText.replace(/×/g, '').trim());
    }

    if (postRes.status >= 200 && postRes.status < 400) {
      return true;
    }
    throw new Error(`Reserva fallida con status ${postRes.status}`);
  }

  public async createAthlete(data: { name: string, phone: string, email?: string }): Promise<boolean> {
    try {
      const cookie = await this.getSession();

      const getRes = await axios.get(`https://crosshero.com/dashboard/admin/athletes/new`, {
        headers: { 'Cookie': cookie }
      });
      const html = getRes.data;
      const tokenMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
      if (!tokenMatch) throw new Error("No se pudo encontrar el Token CSRF para crear atleta.");
      const token = tokenMatch[1];

      const postData = new URLSearchParams();
      postData.append('authenticity_token', token);
      postData.append('athlete[name]', data.name);
      postData.append('athlete[phone]', data.phone);
      if (data.email) {
        postData.append('athlete[email]', data.email);
      }

      const postRes = await axios.post('https://crosshero.com/dashboard/admin/athletes', postData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookie,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        },
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400
      });

      const $res = cheerio.load(postRes.data);
      const alertText = $res('.alert').text().trim();

      if (alertText && !alertText.toLowerCase().includes('éxito') && !alertText.toLowerCase().includes('correctamente')) {
        throw new Error(alertText.replace(/×/g, '').trim());
      }

      return true;
    } catch (error: any) {
      console.error('Error creating athlete in CrossHero scraper:', error.message || error);
      return false;
    }
  }

  public async getClassAttendees(dateStr: string, singleClassId: string): Promise<any[]> {
    const cookie = await this.getSession();
    const url = `https://crosshero.com/dashboard/classes?id=${singleClassId}`;
    const getRes = await axios.get(url, { headers: { 'Cookie': cookie } });

    const $ = cheerio.load(getRes.data);
    const attendees: {name: string, status: string}[] = [];

    $('.ch-classes-athlete-row').each((i, el) => {
      const name = $(el).find('.ch-classes-athlete-row__name-line').text().trim();
      const status = $(el).find('.ch-badge').text().trim();
      if (name) {
        attendees.push({ name, status: status || 'Reservado' });
      }
    });

    return attendees;
  }
}
