#!/bin/bash

# Voice Call Security Setup Script
# Generates a secure API key and helps configure security settings

echo "🔒 Voice Call Security Setup"
echo "=============================="
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found!"
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo "✅ Created .env file"
    echo ""
fi

# Generate API key
echo "Generating secure API key..."
API_KEY=$(openssl rand -base64 32)
echo "✅ Generated: $API_KEY"
echo ""

# Check if VOICE_API_KEY already exists in .env
if grep -q "^VOICE_API_KEY=" .env; then
    echo "⚠️  VOICE_API_KEY already exists in .env"
    read -p "Do you want to replace it? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # Replace existing key
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            sed -i '' "s/^VOICE_API_KEY=.*/VOICE_API_KEY=$API_KEY/" .env
        else
            # Linux
            sed -i "s/^VOICE_API_KEY=.*/VOICE_API_KEY=$API_KEY/" .env
        fi
        echo "✅ Updated VOICE_API_KEY in .env"
    else
        echo "Keeping existing key"
    fi
else
    # Add new key
    echo "" >> .env
    echo "# Voice Call Security (generated $(date))" >> .env
    echo "VOICE_API_KEY=$API_KEY" >> .env
    echo "✅ Added VOICE_API_KEY to .env"
fi

# Check if .env.local exists for frontend
if [ ! -f .env.local ]; then
    echo ""
    echo "Creating .env.local for frontend..."
    echo "# Frontend Environment Variables" > .env.local
    echo "VITE_VOICE_API_KEY=$API_KEY" >> .env.local
    echo "✅ Created .env.local with API key"
else
    echo ""
    echo "⚠️  .env.local already exists"
    if ! grep -q "^VITE_VOICE_API_KEY=" .env.local; then
        echo "VITE_VOICE_API_KEY=$API_KEY" >> .env.local
        echo "✅ Added VITE_VOICE_API_KEY to .env.local"
    else
        echo "VITE_VOICE_API_KEY already configured"
    fi
fi

echo ""
echo "=============================="
echo "✅ Security Setup Complete!"
echo "=============================="
echo ""
echo "Next steps:"
echo "1. Restart your backend server: npm run push-server"
echo "2. Restart your frontend: npm run dev"
echo "3. Test with curl:"
echo ""
echo "   curl -X POST http://localhost:3001/api/voice/call \\"
echo "     -H \"Content-Type: application/json\" \\"
echo "     -H \"X-API-Key: $API_KEY\" \\"
echo "     -d '{\"to\": \"+1234567890\", \"issue\": \"test\"}'"
echo ""
echo "🔐 Your API key has been saved to .env and .env.local"
echo "⚠️  Keep these files secret - they are in .gitignore"
echo ""
