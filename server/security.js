// Security middleware and utilities for Express server
// Install required packages: npm install helmet express-rate-limit express-validator

import rateLimit from 'express-rate-limit';
import { body, query, param, validationResult } from 'express-validator';

/**
 * Security configuration object
 * Customize these values for your production environment
 */
export const securityConfig = {
  // Rate limiting
  rateLimitWindow: 15 * 60 * 1000, // 15 minutes
  rateLimitMax: 100, // requests per window
  
  // Strict rate limit for sensitive endpoints
  strictRateLimitWindow: 15 * 60 * 1000,
  strictRateLimitMax: 10,
  
  // CORS
  allowedOrigins: process.env.NODE_ENV === 'production' 
    ? ['https://yourdomain.com'] // Replace with your actual domain
    : ['http://localhost:5173', 'http://127.0.0.1:5173'],
  
  // Request size limits
  jsonLimit: '1mb',
  urlEncodedLimit: '1mb',
};

/**
 * General rate limiter for most API endpoints
 */
export const generalRateLimiter = rateLimit({
  windowMs: securityConfig.rateLimitWindow,
  max: securityConfig.rateLimitMax,
  message: { ok: false, error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Strict rate limiter for sensitive operations (form submissions, emails)
 */
export const strictRateLimiter = rateLimit({
  windowMs: securityConfig.strictRateLimitWindow,
  max: securityConfig.strictRateLimitMax,
  message: { ok: false, error: 'Too many submission attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * CORS configuration with whitelist
 */
export function corsOptions() {
  return {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);
      
      if (securityConfig.allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    optionsSuccessStatus: 200,
  };
}

/**
 * Helmet configuration for security headers
 * Uncomment and customize after installing helmet
 */
export function getHelmetConfig() {
  return {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://apis.google.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: [
          "'self'",
          "https://api.openai.com",
          "https://www.googleapis.com",
          "https://gmail.googleapis.com",
          "https://api.fred.louisfed.org",
        ],
        frameSrc: ["'self'", "https://apis.google.com"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  };
}

/**
 * Input sanitization helper - removes potentially dangerous characters
 */
export function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  
  return input
    .trim()
    .replace(/[<>]/g, '') // Remove angle brackets to prevent HTML injection
    .slice(0, 10000); // Limit length
}

/**
 * Validation middleware - catches validation errors
 */
export function validateRequest(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Validation failed', 
      details: errors.array() 
    });
  }
  next();
}

/**
 * Common validation chains for reuse
 */
export const validators = {
  email: body('email')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Invalid email format'),
  
  phone: body('phone')
    .optional()
    .matches(/^[\d\s\-\+\(\)]+$/)
    .withMessage('Invalid phone format'),
  
  url: body('url')
    .isURL({ protocols: ['http', 'https'], require_protocol: true })
    .withMessage('Invalid URL'),
  
  address: body('address')
    .trim()
    .isLength({ min: 5, max: 500 })
    .withMessage('Address must be 5-500 characters'),
  
  message: body('message')
    .trim()
    .isLength({ min: 10, max: 5000 })
    .withMessage('Message must be 10-5000 characters'),
  
  name: body('name')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Name must be 1-200 characters'),
  
  queryString: query('q')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Query too long'),
  
  id: param('id')
    .matches(/^[a-zA-Z0-9\-_]+$/)
    .withMessage('Invalid ID format'),
};

/**
 * Security logger middleware
 */
export function securityLogger(req, res, next) {
  const timestamp = new Date().toISOString();
  const ip = req.ip || req.connection.remoteAddress;
  const userAgent = req.get('user-agent') || 'unknown';
  
  // Log security-relevant events
  console.log(`[${timestamp}] ${req.method} ${req.path} - IP: ${ip} - UA: ${userAgent.slice(0, 100)}`);
  
  // TODO: Send to proper logging service in production (e.g., Winston, Datadog)
  
  next();
}

/**
 * Token verification middleware
 */
export function requireValidToken(verifyTokenFn) {
  return (req, res, next) => {
    const token = req.query.token || req.body.token || req.headers['x-token'];
    
    if (!token) {
      return res.status(401).json({ ok: false, error: 'Missing token' });
    }
    
    const payload = verifyTokenFn(token);
    if (!payload) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    }
    
    req.tokenPayload = payload;
    next();
  };
}

/**
 * Environment variable validator - checks required env vars on startup
 */
export function validateEnvironment(requiredVars) {
  const missing = [];
  const weak = [];
  
  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }
  
  // Check for weak secrets
  if (!process.env.APPOINTMENT_TOKEN_SECRET) {
    weak.push('APPOINTMENT_TOKEN_SECRET (missing; ephemeral dev secret will be used)');
  }
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    console.error('Please check your .env file against .env.example');
  }
  
  if (weak.length > 0) {
    console.warn('⚠️  Weak security configuration detected:', weak.join(', '));
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Cannot start in production with weak security settings');
    }
  }
  
  return missing.length === 0;
}

/**
 * Sanitize all string inputs in request body
 */
export function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    for (const key in req.body) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = sanitizeInput(req.body[key]);
      }
    }
  }
  next();
}

/**
 * Error handler that doesn't leak stack traces in production
 */
export function secureErrorHandler(err, req, res, next) {
  console.error('Error:', err);
  
  const isDev = process.env.NODE_ENV !== 'production';
  
  res.status(err.status || 500).json({
    ok: false,
    error: err.message || 'Internal server error',
    ...(isDev && { stack: err.stack }), // Only include stack in development
  });
}
