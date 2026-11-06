import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { parseEnvironment } from './common/config/environment.js';
import { ApiExceptionFilter } from './common/http/api-exception.filter.js';
import { requestIdMiddleware } from './common/http/request-id.middleware.js';

export async function createApp(
  input: Record<string, unknown> = process.env,
  logger: false | undefined = undefined,
) {
  const environment = parseEnvironment(input);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(environment),
    {
      logger,
      rawBody: true,
      bodyParser: false,
      abortOnError: false,
    },
  );
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(requestIdMiddleware);
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '1mb' });
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: environment.CORS_ORIGIN,
    credentials: false,
    exposedHeaders: ['X-Request-Id'],
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  if (environment.SWAGGER_ENABLED ?? environment.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('ResolveAI Backend')
      .setDescription(
        'ResolveAI backend: health, merchant integrations and verified PayPal webhooks. User JWTs are issued by Supabase Auth.',
      )
      .setVersion('0.1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'supabase',
      )
      .build();
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(app, config),
      { jsonDocumentUrl: '/api/openapi.json' },
    );
  }
  app.enableShutdownHooks();
  return { app, environment };
}
