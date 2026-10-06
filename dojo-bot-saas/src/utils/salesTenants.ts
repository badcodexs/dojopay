const salesTenantPhones = new Set(
  (process.env.SALES_DEMO_TENANT_PHONES ?? '')
    .split(',')
    .map((phone) => phone.trim())
    .filter(Boolean)
);

export const isSalesTenant = (tenantPhone: string): boolean => salesTenantPhones.has(tenantPhone);
