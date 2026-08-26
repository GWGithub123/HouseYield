#!/usr/bin/env node

/**
 * QuickBooks Sync Database Migration
 * Applies the QuickBooks mapping schema to the database
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database path - try both locations
const DB_PATH_1 = path.join(__dirname, 'data', 'bookkeeping', 'accounting.db');
const DB_PATH_2 = path.join(__dirname, 'data', 'bookkeeping.db');
const DB_PATH = fs.existsSync(DB_PATH_1) ? DB_PATH_1 : DB_PATH_2;
const SCHEMA_PATH = path.join(__dirname, 'db', 'qbo-mappings-schema.sql');

console.log('🔧 QuickBooks Sync Database Migration');
console.log('=====================================\n');

try {
  // Check if database exists
  if (!fs.existsSync(DB_PATH)) {
    console.error('❌ Database not found at:', DB_PATH);
    console.log('Please run the bookkeeping system first to create the database.\n');
    process.exit(1);
  }
  
  // Check if schema file exists
  if (!fs.existsSync(SCHEMA_PATH)) {
    console.error('❌ Schema file not found at:', SCHEMA_PATH);
    process.exit(1);
  }
  
  // Read schema
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  
  // Connect to database
  console.log('📁 Opening database:', DB_PATH);
  const db = new Database(DB_PATH);
  
  // Execute schema
  console.log('📝 Applying QuickBooks mapping schema...\n');
  db.exec(schema);
  
  // Verify tables were created
  const tables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name LIKE 'qbo_%'
    ORDER BY name
  `).all();
  
  console.log('✅ QuickBooks tables created:');
  tables.forEach(table => {
    console.log(`   - ${table.name}`);
  });
  
  console.log('\n✅ Migration completed successfully!');
  console.log('\nNext steps:');
  console.log('1. Connect to QuickBooks via /api/quickbooks/auth');
  console.log('2. Map your properties to QuickBooks Locations');
  console.log('3. Map your Chart of Accounts to QuickBooks Accounts');
  console.log('4. Set the equity plug account');
  console.log('5. Start syncing monthly summaries!\n');
  
  db.close();
  
} catch (error) {
  console.error('❌ Migration failed:', error.message);
  console.error(error.stack);
  process.exit(1);
}
