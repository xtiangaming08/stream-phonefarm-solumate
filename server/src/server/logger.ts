export enum LogLevel {
    Silent = 0,
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
}

const namedLevels: Record<string, LogLevel> = {
    silent: LogLevel.Silent,
    off: LogLevel.Silent,
    error: LogLevel.Error,
    warn: LogLevel.Warn,
    info: LogLevel.Info,
    debug: LogLevel.Debug,
};

const envLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const currentLogLevel = namedLevels[envLevel] ?? LogLevel.Info;

const shouldLog = (level: LogLevel): boolean => currentLogLevel >= level;

const noop = (): void => {};

const logWithLevel = (level: LogLevel, target: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
        if (shouldLog(level)) {
            target(...args);
        }
    };
};

export const logger = {
    error: logWithLevel(LogLevel.Error, console.error),
    warn: logWithLevel(LogLevel.Warn, console.warn ?? console.log),
    info: logWithLevel(LogLevel.Info, console.log),
    debug: logWithLevel(LogLevel.Debug, console.log),
};
