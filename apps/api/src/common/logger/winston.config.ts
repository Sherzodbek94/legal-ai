import { WinstonModuleOptions, utilities as nestWinstonUtilities } from 'nest-winston';
import * as winston from 'winston';

const isProduction = process.env.NODE_ENV === 'production';

export const winstonConfig: WinstonModuleOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  transports: [
    new winston.transports.Console({
      format: isProduction
        ? winston.format.combine(winston.format.timestamp(), winston.format.json())
        : winston.format.combine(
            winston.format.timestamp(),
            winston.format.ms(),
            nestWinstonUtilities.format.nestLike('LegalTechAPI', {
              colors: true,
              prettyPrint: true,
            }),
          ),
    }),
  ],
};
