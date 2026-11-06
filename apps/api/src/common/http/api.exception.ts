import { HttpException } from '@nestjs/common';

// Only explicitly public, constant messages belong here. Never pass upstream errors.
export class ApiException extends HttpException {
  constructor(
    public readonly code: string,
    public readonly publicMessage: string,
    status: number,
  ) {
    super(publicMessage, status);
  }
}
