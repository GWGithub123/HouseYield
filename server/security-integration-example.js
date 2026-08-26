// Example: How to integrate security middleware into server/index.js
// This file shows the changes needed - DO NOT run as-is, integrate carefully

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import helmet from 'helmet'; // npm install helmet
import rateLimit from 'express-rate-limit'; // npm install express-rate-limit

// Import security utilities
import {
  generalRateLimiter,
  strictRateLimiter,
  corsOptions,
  getHelmetConfig,
  validateRequest,
  validators,
  securityLogger,
  sanitizeBody,
  secureErrorHandler,
  validateEnvironment,
} from './security.js';

// Validate environment on startup
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'APPOINTMENT_TOKEN_SECRET',
];

if (!validateEnvironment(requiredEnvVars)) {
  console.error('Environment validation failed. Check your .env file.');
  process.exit(1);
}

const app = express();

// 1. Security headers (MUST be first)
app.use(helmet(getHelmetConfig()));

// 2. CORS with whitelist
app.use(cors(corsOptions()));

// 3. Request size limits (prevent payload attacks)
app.use(bodyParser.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 4. Security logging
app.use(securityLogger);

// 5. Input sanitization
app.use(sanitizeBody);

// 6. Apply general rate limiting to all API routes
app.use('/api/', generalRateLimiter);

// Example: Protected form submission endpoint with strict rate limiting and validation
app.post('/api/form-schedule',
  strictRateLimiter, // Strict rate limit for submissions
  [
    validators.url,
    validators.message,
    validators.address,
    validators.email,
    validators.phone,
    validators.name,
  ],
  validateRequest,
  async (req, res) => {
    // Your existing form submission logic here
    // req.body is now validated and sanitized
  }
);

// Example: Search endpoint with validation
app.get('/service-search',
  generalRateLimiter,
  [
    query('description')
      .trim()
      .isLength({ min: 3, max: 500 })
      .withMessage('Description must be 3-500 characters'),
  ],
  validateRequest,
  async (req, res) => {
    // Your existing search logic here
  }
);

// Example: Protected appointment confirmation with token validation
import { verifyToken } from './appointments/tokens.js';
import { requireValidToken } from './security.js';

app.get('/api/appointments/confirm',
  requireValidToken(verifyToken),
  async (req, res) => {
    const payload = req.tokenPayload; // Set by requireValidToken middleware
    // Your confirmation logic here
  }
);

// Example: ATTOM endpoint with input validation
app.get('/api/attom/dashboard',
  generalRateLimiter,
  [
    query('address')
      .optional()
      .trim()
      .isLength({ min: 5, max: 500 })
      .withMessage('Invalid address'),
    query('id')
      .optional()
      .matches(/^[a-zA-Z0-9\-]+$/)
      .withMessage('Invalid ID format'),
  ],
  validateRequest,
  async (req, res) => {
    // Your ATTOM logic here
  }
);

// Error handler (MUST be last)
app.use(secureErrorHandler);

const PORT = parseInt(process.env.PORT || '3001', 10);
app.listen(PORT, () => {
  console.log(`[push-server] listening on http://localhost:${PORT}`);
  console.log('Security features enabled:');
  console.log('✓ Helmet security headers');
  console.log('✓ CORS whitelist');
  console.log('✓ Rate limiting');
  console.log('✓ Input validation');
  console.log('✓ Request sanitization');
  console.log('✓ Security logging');
});
