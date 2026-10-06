export function calculateNextDueDate(
  currentPaidUntilDate: string,
  paymentDay: number,
  amountPaid: number,
  planPrice: number,
  forceResetDate?: Date
): string {
  if (planPrice <= 0) throw new Error("El precio del plan debe ser mayor a cero");

  const baseDate = forceResetDate ? new Date(forceResetDate) : new Date(currentPaidUntilDate);
  const monthsPaid = amountPaid / planPrice;

  if (Number.isInteger(monthsPaid)) {
    baseDate.setUTCMonth(baseDate.getUTCMonth() + monthsPaid);
    baseDate.setUTCDate(paymentDay);
  } else {
    const daysToAdd = Math.round(monthsPaid * 30.436875);
    baseDate.setUTCDate(baseDate.getUTCDate() + daysToAdd);
  }

  return baseDate.toISOString();
}
