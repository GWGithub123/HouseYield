/**
 * Simple Audit Logging System
 * Logs security-relevant events for compliance
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'server', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Log levels
export const LogLevel = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  SECURITY: 'SECURITY',
  AUDIT: 'AUDIT'
};

// Event types for Plaid security questionnaire compliance
export const EventType = {
  // Authentication & Access
  USER_LOGIN: 'USER_LOGIN',
  USER_LOGOUT: 'USER_LOGOUT',
  LOGIN_FAILED: 'LOGIN_FAILED',
  ACCESS_DENIED: 'ACCESS_DENIED',
  
  // Bank Connection (Plaid)
  BANK_CONNECTED: 'BANK_CONNECTED',
  BANK_DISCONNECTED: 'BANK_DISCONNECTED',
  TRANSACTIONS_SYNCED: 'TRANSACTIONS_SYNCED',
  PLAID_API_ERROR: 'PLAID_API_ERROR',
  
  // Data Access
  SENSITIVE_DATA_ACCESS: 'SENSITIVE_DATA_ACCESS',
  DATA_EXPORT: 'DATA_EXPORT',
  DATA_DELETION: 'DATA_DELETION',
  
  // Configuration
  CONFIG_CHANGED: 'CONFIG_CHANGED',
  API_KEY_ROTATED: 'API_KEY_ROTATED',
  
  // Errors
  SERVER_ERROR: 'SERVER_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  
  // Security
  ENCRYPTION_KEY_USED: 'ENCRYPTION_KEY_USED',
  SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY'
};

/**
 * Write audit log entry
 * @param {string} level - Log level
 * @param {string} eventType - Type of event
 * @param {string} userId - User ID (if applicable)
 * @param {object} details - Additional details
 * @param {string} ipAddress - IP address (if available)
 */
export function auditLog(level, eventType, userId, details = {}, ipAddress = null) {
  const timestamp = new Date().toISOString();
  
  const logEntry = {
    timestamp,
    level,
    eventType,
    userId: userId || 'system',
    ipAddress,
    details,
    environment: process.env.NODE_ENV || 'development'
  };
  
  // Write to date-based log file
  const logFile = path.join(LOG_DIR, `audit-${new Date().toISOString().split('T')[0]}.log`);
  
  try {
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
  } catch (error) {
    console.error('Failed to write audit log:', error);
  }
  
  // Also log to console in development
  if (process.env.NODE_ENV !== 'production') {
    const prefix = level === LogLevel.SECURITY || level === LogLevel.AUDIT ? '🔐' : 
                   level === LogLevel.ERROR ? '❌' :
                   level === LogLevel.WARN ? '⚠️' : 'ℹ️';
    console.log(`${prefix} [${level}] ${eventType}:`, details);
  }
}

/**
 * Convenience function for security events
 */
export function securityLog(eventType, userId, details, ipAddress) {
  auditLog(LogLevel.SECURITY, eventType, userId, details, ipAddress);
}

/**
 * Convenience function for errors
 */
export function errorLog(eventType, userId, error, ipAddress) {
  auditLog(LogLevel.ERROR, eventType, userId, {
    error: error.message,
    stack: error.stack,
    code: error.code
  }, ipAddress);
}

/**
 * Middleware to extract IP address from request
 */
export function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         'unknown';
}

/**
 * Express middleware for automatic request logging
 */
export function auditMiddleware(req, res, next) {
  const startTime = Date.now();
  
  // Log request
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const userId = req.user?.id || req.headers['x-user-id'] || 'anonymous';
    
    // Only log security-relevant endpoints
    const sensitiveEndpoints = ['/api/plaid', '/api/bookkeeping', '/api/auth'];
    const isSensitive = sensitiveEndpoints.some(endpoint => req.path.startsWith(endpoint));
    
    if (isSensitive || res.statusCode >= 400) {
      auditLog(
        res.statusCode >= 400 ? LogLevel.WARN : LogLevel.INFO,
        'API_REQUEST',
        userId,
        {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          duration: `${duration}ms`,
          userAgent: req.headers['user-agent']
        },
        getClientIp(req)
      );
    }
  });
  
  next();
}

/**
 * Clean up old log files (keep last 90 days)
 */
export function cleanupOldLogs(daysToKeep = 90) {
  const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
  
  fs.readdirSync(LOG_DIR).forEach(file => {
    if (!file.startsWith('audit-')) return;
    
    const filePath = path.join(LOG_DIR, file);
    const stats = fs.statSync(filePath);
    
    if (stats.mtime < cutoffDate) {
      fs.unlinkSync(filePath);
      console.log(`Deleted old log file: ${file}`);
    }
  });
}

// Auto-cleanup on startup (in production only)
if (process.env.NODE_ENV === 'production') {
  cleanupOldLogs();
}

export default {
  auditLog,
  securityLog,
  errorLog,
  getClientIp,
  auditMiddleware,
  cleanupOldLogs,
  LogLevel,
  EventType
};
