import { Prisma } from '../../generated/prisma/client.js';

// The default Decimal precision (20 digits) is below NUMERIC(24,8).
// Keep arithmetic exact without changing Decimal's global configuration.
export const PaymentMoney = Prisma.Decimal.clone({ precision: 40 });
