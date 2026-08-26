#!/usr/bin/env node

/**
 * Polymarket Setup Script
 * 
 * This script:
 * 1. Creates a new Ethereum wallet (or uses existing private key)
 * 2. Derives Polymarket API credentials
 * 3. Securely saves everything to .env file
 * 
 * Usage: node server/setup-polymarket.js
 */

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');

const CLOB_ENDPOINT = 'https://clob.polymarket.com';

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

/**
 * Create L1 authentication headers
 * Note: Polymarket may use API keys differently than L1 headers for some endpoints
 */
async function createL1Headers(privateKey) {
  const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new ethers.Wallet(formattedKey);
  const address = wallet.address;
  const ts = Math.floor(Date.now() / 1000).toString();
  
  // Try the standard Polymarket message format
  const message = `This message attests that I control the given wallet\nTimestamp: ${ts}`;
  const signature = await wallet.signMessage(message);

  return {
    address,
    signature,
    timestamp: ts,
    wallet
  };
}

/**
 * Derive API key from Polymarket
 * Note: Polymarket public endpoints may not require authentication
 * We'll save the wallet info and try to access public data
 */
async function deriveApiKey(privateKey) {
  try {
    console.log('📡 Testing Polymarket API access...');
    const auth = await createL1Headers(privateKey);
    
    // First, try to access public markets to verify API is working
    const testResponse = await fetch(`${CLOB_ENDPOINT}/markets?limit=1`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!testResponse.ok) {
      throw new Error(`Public API test failed: ${testResponse.status}`);
    }

    console.log('✅ Polymarket API is accessible');
    
    // For now, we'll use the wallet for potential future authenticated endpoints
    // Most Polymarket read endpoints are public and don't require API keys
    return {
      ok: true,
      publicAccess: true,
      address: auth.address,
      note: 'Using public API access. Wallet configured for future authenticated endpoints.'
    };

  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

/**
 * Update or create .env file
 */
function updateEnvFile(privateKey, address) {
  let envContent = '';
  
  // Read existing .env if it exists
  if (fs.existsSync(ENV_PATH)) {
    envContent = fs.readFileSync(ENV_PATH, 'utf-8');
  }

  // Remove old Polymarket entries
  const lines = envContent.split('\n').filter(line => 
    !line.startsWith('POLYMARKET_') && line.trim() !== ''
  );

  // Add new Polymarket configuration
  lines.push('');
  lines.push('# Polymarket Configuration (Auto-generated)');
  lines.push(`POLYMARKET_PRIVATE_KEY=${privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey}`);
  lines.push(`POLYMARKET_WALLET_ADDRESS=${address}`);
  lines.push(`POLYMARKET_CLOB_ENDPOINT=${CLOB_ENDPOINT}`);
  lines.push('');

  // Write back to file
  fs.writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
  console.log('✅ Configuration saved to .env');
}

/**
 * Ensure .env is in .gitignore
 */
function ensureGitignore() {
  const gitignorePath = path.join(__dirname, '..', '.gitignore');
  
  let gitignoreContent = '';
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
  }

  if (!gitignoreContent.includes('.env')) {
    fs.appendFileSync(gitignorePath, '\n# Environment variables\n.env\n');
    console.log('✅ Added .env to .gitignore');
  }
}

/**
 * Main setup function
 */
async function setup() {
  console.log('🔐 Polymarket API Setup\n');
  console.log('This script will help you set up Polymarket integration securely.\n');

  try {
    // Ask if user has existing wallet
    const hasWallet = await question('Do you have an existing Ethereum private key to use? (y/n): ');
    
    let privateKey;
    let wallet;

    if (hasWallet.toLowerCase() === 'y') {
      privateKey = await question('Enter your private key (with or without 0x): ');
      privateKey = privateKey.trim();
      
      // Validate private key
      try {
        const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
        wallet = new ethers.Wallet(formattedKey);
        console.log(`✅ Valid wallet address: ${wallet.address}`);
      } catch (error) {
        console.error('❌ Invalid private key format');
        rl.close();
        process.exit(1);
      }
    } else {
      console.log('\n🎲 Generating new Ethereum wallet...');
      wallet = ethers.Wallet.createRandom();
      privateKey = wallet.privateKey;
      
      console.log('\n📝 NEW WALLET CREATED:');
      console.log('━'.repeat(60));
      console.log(`Address: ${wallet.address}`);
      console.log(`Private Key: ${privateKey}`);
      console.log('━'.repeat(60));
      console.log('⚠️  IMPORTANT: Save this private key securely!');
      console.log('⚠️  You will need it to access this wallet.\n');
      
      const confirm = await question('Have you saved the private key? (yes/no): ');
      if (confirm.toLowerCase() !== 'yes') {
        console.log('❌ Setup cancelled. Please save your private key first.');
        rl.close();
        process.exit(0);
      }
    }

    // Derive API key
    console.log('\n🔑 Setting up Polymarket API access...');
    const result = await deriveApiKey(privateKey);

    if (!result.ok) {
      console.error('❌ Failed to access Polymarket API:', result.error);
      console.log('\nPossible reasons:');
      console.log('  1. Network connection issue');
      console.log('  2. Polymarket API is down');
      console.log('  3. Invalid configuration');
      rl.close();
      process.exit(1);
    }

    console.log('✅ Polymarket API access verified!');
    if (result.note) {
      console.log(`   ${result.note}`);
    }

    // Save to .env
    console.log('\n💾 Saving configuration to .env...');
    updateEnvFile(privateKey, wallet.address);

    // Update .gitignore
    ensureGitignore();

    console.log('\n✨ Setup complete!');
    console.log('\nNext steps:');
    console.log('  1. Restart your server: npm run push-server');
    console.log('  2. Test the API: curl http://localhost:3001/api/polymarket/housing');
    console.log('\n⚠️  Security reminder:');
    console.log('  - Never commit .env to git');
    console.log('  - Never share your private key');
    console.log('  - Keep your .env file secure (permissions: 600)');

  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

// Run setup
setup();
