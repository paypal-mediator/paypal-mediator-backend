import { Module } from '@nestjs/common';
import { AuditModule } from '../monitoring/audit.module.js';
import { JobsModule } from '../jobs/index.js';
import { MerchantsModule } from '../merchants/index.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { BindAdapter } from './adapters/bind.adapter.js';
import { MockErpAdapter } from './adapters/mock-erp.adapter.js';
import { SiigoAdapter } from './adapters/siigo.adapter.js';
import { OdooAdapter } from './adapters/odoo.adapter.js';
import { ErpNextAdapter } from './adapters/erpnext.adapter.js';

@Module({
  imports: [AuditModule, JobsModule, MerchantsModule],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    BindAdapter,
    MockErpAdapter,
    SiigoAdapter,
    OdooAdapter,
    ErpNextAdapter,
  ],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
