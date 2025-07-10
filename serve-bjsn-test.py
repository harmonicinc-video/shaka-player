#!/usr/bin/env python3
"""
Simple HTTP server to test BJSN implementation
Usage: python3 serve-bjsn-test.py
"""

import http.server
import socketserver
import os
import sys

# Change to the Shaka Player directory
os.chdir('/Users/elvisfan/development/agentCode/shaka-player')

# Set up the server
PORT = 8082
Handler = http.server.SimpleHTTPRequestHandler

# Add CORS headers for testing
class CORSHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

try:
    with socketserver.TCPServer(("", PORT), CORSHTTPRequestHandler) as httpd:
        print(f"🎬 BJSN Test Server starting on port {PORT}")
        print(f"📡 Open your browser to: http://localhost:{PORT}/bjsn-test.html")
        print(f"🎯 BJSN implementation is ready for testing!")
        print(f"⚡ Press Ctrl+C to stop the server")
        httpd.serve_forever()
except KeyboardInterrupt:
    print("\n🛑 Server stopped")
    sys.exit(0)
except Exception as e:
    print(f"❌ Error starting server: {e}")
    sys.exit(1)
