import { SDK_CONFIG } from '../utils/config';

export const log = (message: string, ...args: any[]) => {
  if (SDK_CONFIG.enableLogs) {
    console.log(message, ...args);
  }
};

export const warn = (message: string, ...args: any[]) => {
  if (SDK_CONFIG.enableLogs) {
    console.warn(message, ...args);
  }
};

export const info = (message: string, ...args: any[]) => {
  if (SDK_CONFIG.enableLogs) {
    console.info(message, ...args);
  }
};