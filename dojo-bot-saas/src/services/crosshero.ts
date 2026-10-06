import axios from 'axios';

const CROSSHERO_API_BASE = 'https://crosshero.com/api/v1';

export class CrossHeroService {
  private boxId: string;
  private accessToken: string;

  constructor(boxId: string, accessToken: string) {
    this.boxId = boxId;
    this.accessToken = accessToken;
  }

  private get headers() {
    return {
      'CROSSHERO-BOX': this.boxId,
      'CROSSHERO-ACCESS-TOKEN': this.accessToken,
      'Content-Type': 'application/json',
    };
  }

  async findAthleteByName(nameQuery: string): Promise<any[]> {
    try {
      const response = await axios.get(`${CROSSHERO_API_BASE}/athletes`, {
        headers: this.headers,
        params: { search: nameQuery }
      });
      return response.data;
    } catch (error: any) {
      console.error('Error fetching athletes from CrossHero:', error?.response?.data || error.message);
      return [];
    }
  }

  async approvePayment(athleteId: string, amount: number, method: string = 'TRANSFER'): Promise<boolean> {
    try {
      const payload = {
        payment: {
          amount: amount,
          payment_method: method,
          status: 'paid'
        }
      };

      const response = await axios.post(`${CROSSHERO_API_BASE}/athletes/${athleteId}/payments`, payload, {
        headers: this.headers
      });
      return response.status === 200 || response.status === 201;
    } catch (error: any) {
      console.error('Error approving payment in CrossHero:', error?.response?.data || error.message);
      return false;
    }
  }

  async getAllAthletes(): Promise<any[]> {
    try {
      let allAthletes: any[] = [];
      let currentPage = 1;
      let totalPages = 1;

      while (currentPage <= totalPages) {
        const response = await axios.get(`${CROSSHERO_API_BASE}/athletes`, {
          headers: this.headers,
          params: { page: currentPage, per_page: 100 }
        });

        const data = response.data;
        if (data && data.athletes) {
          allAthletes = allAthletes.concat(data.athletes);
        }

        if (data.meta) {
          totalPages = data.meta.total_pages || 1;
        } else {
          break;
        }
        currentPage++;
      }
      return allAthletes;
    } catch (error: any) {
      console.error('Error fetching all athletes from CrossHero:', error?.response?.data || error.message);
      return [];
    }
  }

  async getAthleteByPhone(phone: string): Promise<any> {
    const athletes = await this.getAllAthletes();
    return athletes.find((a: any) =>
      (a.phone && a.phone.includes(phone)) ||
      (a.code && a.code === phone)
    ) || null;
  }
}
