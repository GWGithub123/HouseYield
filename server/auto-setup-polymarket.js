#!/usr/bin/env node

/**
 * Automated Polymarket Setup Script
 * Generates wallet and configures Polymarket API access automatically
 */

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');
const CLOB_ENDPOINT = 'https://clob.polymarket.com';

async function autoSetup() {
  console.log('🔐 Polymarket Auto-Setup\n');

  try {
    // Generate new wallet
    console.log('🎲 Generating Ethereum wallet...');
    const wallet = ethers.Wallet.createRandom();
    
    console.log('✅ Wallet created:');
    console.log(`   Address: ${wallet.address}`);
    console.log(`   Private Key: ${wallet.privateKey}`);

    // Test Polymarket API
    console.log('\n📡 Testing Polymarket API...');
    const testResponse = await fetch(`${CLOB_ENDPOINT}/markets?limit=1`);
    
    if (!testResponse.ok) {
      throw new Error(`API test failed: ${testResponse.status}`);
    }
    
    console.log('✅ Polymarket API is accessible');

    // Update .env file
    console.log('\n💾 Updating .env file...');
    let envContent = '';
    
    if (fs.existsSync(ENV_PATH)) {
      envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    }

    // Remove old Polymarket entries
    const lines = envContent.split('\n').filter(line => 
      !line.startsWith('POLYMARKET_') && line.trim() !== ''
    );

    // Add new configuration
    lines.push('');
    lines.push('# Polymarket Configuration (Auto-generated ' + new Date().toISOString() + ')');
    lines.push(`POLYMARKET_PRIVATE_KEY=${wallet.privateKey.slice(2)}`); // Remove 0x
    lines.push(`POLYMARKET_WALLET_ADDRESS=${wallet.address}`);
    lines.push(`POLYMARKET_CLOB_ENDPOINT=${CLOB_ENDPOINT}`);
    lines.push('');

    fs.writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
    console.log('✅ Configuration saved to .env');

    // Update .gitignore
    const gitignorePath = path.join(__dirname, '..', '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      let gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
      if (!gitignoreContent.includes('.env')) {
        fs.appendFileSync(gitignorePath, '\n.env\n');
        console.log('✅ Added .env to .gitignore');
      }
    }

    console.log('\n✨ Setup complete!\n');
    console.log('⚠️  IMPORTANT - Save this information:');
    console.log('━'.repeat(70));
    console.log(`Wallet Address: ${wallet.address}`);
    console.log(`Private Key: ${wallet.privateKey}`);
    console.log('━'.repeat(70));
    console.log('\nNext steps:');
    console.log('  1. Restart your server: npm run push-server');
    console.log('  2. Test the API: curl http://localhost:3001/api/polymarket/housing\n');

  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    process.exit(1);
  }
}

autoSetup();
