import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  HealthResponseSchema,
  ReadinessResponseSchema,
  type HealthResponse,
  type ReadinessResponse,
} from '@resolve-ai/contracts';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { PrismaService } from '../../common/database/prisma.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Process liveness; does not check external services',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      required: ['status', 'service', 'environment', 'timestamp'],
      properties: {
        status: { type: 'string', enum: ['ok'] },
        service: { type: 'string', enum: ['resolve-ai-api'] },
        environment: {
          type: 'string',
          enum: ['development', 'test', 'production'],
        },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  live(): HealthResponse {
    return HealthResponseSchema.parse({
      status: 'ok',
      service: 'resolve-ai-api',
      environment: this.environment.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Database readiness; performs SELECT 1 against PostgreSQL',
  })
  @ApiResponse({
    status: 200,
    description: 'Database reachable',
    schema: {
      type: 'object',
      required: ['status', 'checks', 'timestamp'],
      properties: {
        status: { type: 'string', enum: ['ready'] },
        checks: {
          type: 'object',
          properties: { database: { type: 'string', enum: ['up'] } },
        },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'Database unavailable; standard ApiError response',
  })
  async ready(): Promise<ReadinessResponse> {
    if (!(await this.prisma.isHealthy())) {
      throw new ServiceUnavailableException();
    }
    return ReadinessResponseSchema.parse({
      status: 'ready',
      checks: { database: 'up' },
      timestamp: new Date().toISOString(),
    });
  }
}
