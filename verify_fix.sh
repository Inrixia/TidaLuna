#!/bin/bash
set -e # Exit immediately if a command exits with a non-zero status.

echo "=========================================="
echo "   TidaLuna Fix Verification"
echo "=========================================="

# 1. Install Dependencies
echo "[+] Step 1: Installing dependencies..."
npm install

# 2. Build Project
echo "[+] Step 2: Building project..."
npm run build

# 3. Verify Output
echo "[+] Step 3: Verifying build artifacts..."
if ls dist/*.native.mjs 1> /dev/null 2>&1; then
    echo "SUCCESS: Native modules generated."
    echo "Found the following native modules:"
    ls -lh dist/*.native.mjs
else
    echo "ERROR: No native modules found in dist/. Build might be incomplete."
    exit 1
fi

echo "=========================================="
echo "   Verification Successful!"
echo "=========================================="
echo "The project was built successfully."
echo "You can now run the application."
