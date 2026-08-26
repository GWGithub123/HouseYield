#!/bin/bash
# GPG Setup Script for Signed Git Commits

echo "🔐 Setting up GPG for signed Git commits..."
echo ""

# Step 1: Install Homebrew (if not installed)
if ! command -v brew &> /dev/null; then
    echo "📦 Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    
    # Add Homebrew to PATH for Apple Silicon Macs
    if [[ $(uname -m) == 'arm64' ]]; then
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
else
    echo "✅ Homebrew already installed"
fi

# Step 2: Install GPG
echo ""
echo "🔧 Installing GPG..."
brew install gnupg

# Step 3: Verify installation
echo ""
echo "✅ Checking GPG installation..."
gpg --version

# Step 4: Configure Git to use GPG
echo ""
echo "⚙️  Configuring Git..."
git config --global gpg.program $(which gpg)

# Step 5: Show current signing key
echo ""
echo "🔑 Current Git signing key:"
git config --get user.signingkey || echo "No signing key configured"

echo ""
echo "✅ GPG setup complete!"
echo ""
echo "📝 Next steps:"
echo "1. If you don't have a GPG key yet, create one:"
echo "   gpg --full-generate-key"
echo ""
echo "2. List your GPG keys:"
echo "   gpg --list-secret-keys --keyid-format=long"
echo ""
echo "3. Configure Git to use your key:"
echo "   git config --global user.signingkey YOUR_KEY_ID"
echo ""
echo "4. Enable commit signing:"
echo "   git config --global commit.gpgsign true"
echo ""
echo "5. Export your public key to add to GitHub:"
echo "   gpg --armor --export YOUR_EMAIL"
