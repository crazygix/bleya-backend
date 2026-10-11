import pino from 'pino';
import { config } from '../config/index.js';
import { reportError, setErrorReportFailureHandler } from './errorReporter.js';

type LogContext = { [key: string]: unknown };

const pinoInstance = pino({
  level: config.isProduction ? 'info' : 'debug',
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  messageKey: 'message',
});

// The reporter can't log through this logger (each error would report itself).
setErrorReportFailureHandler(() => pinoInstance.warn('error_report.send_failed'));

// Wrapper preserving the existing (message, context?) call signature
// while delegating to Pino's async, non-blocking writes.
const logger = {
  debug(message: string, context?: LogContext): void {
    context ? pinoInstance.debug({ context }, message) : pinoInstance.debug(message);
  },
  info(message: string, context?: LogContext): void {
    context ? pinoInstance.info({ context }, message) : pinoInstance.info(message);
  },
  warn(message: string, context?: LogContext): void {
    context ? pinoInstance.warn({ context }, message) : pinoInstance.warn(message);
  },
  // Errors are also sent to the Telegram errors chat (utils/errorReporter).
  error(message: string, context?: LogContext): void {
    context ? pinoInstance.error({ context }, message) : pinoInstance.error(message);
    reportError(message, context);
  },
};

export default logger;
