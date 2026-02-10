type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

function writeLog(level: LogLevel, message: string, context?: LogContext): void {
  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  if (context && Object.keys(context).length > 0) {
    payload.context = context;
  }

  const line = `${JSON.stringify(payload)}\n`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line);
}

const logger = {
  debug(message: string, context?: LogContext): void {
    writeLog('debug', message, context);
  },
  info(message: string, context?: LogContext): void {
    writeLog('info', message, context);
  },
  warn(message: string, context?: LogContext): void {
    writeLog('warn', message, context);
  },
  error(message: string, context?: LogContext): void {
    writeLog('error', message, context);
  },
};

export default logger;
