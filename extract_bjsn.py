#!/usr/bin/env python3
import sys
import requests
import json

def find_bjsn_box(data):
    """Find BJSN box in MP4 data"""
    i = 0
    while i < len(data) - 8:
        # Read box size (4 bytes, big-endian)
        box_size = int.from_bytes(data[i:i+4], 'big')
        if box_size == 0:
            break
        if box_size == 1:
            # Extended size, skip for now
            i += 16
            continue
        if box_size < 8:
            # Invalid box size
            i += 1
            continue
        
        # Read box type (4 bytes)
        box_type = data[i+4:i+8]
        
        if box_type == b'bjsn':
            # Found BJSN box, extract payload
            payload_start = i + 8
            payload_end = i + box_size
            if payload_end > len(data):
                break
            return data[payload_start:payload_end]
        
        # Move to next box
        i += box_size
    
    return None

def extract_bjsn_from_url(url):
    """Extract BJSN data from URL"""
    try:
        # Download only the first part of the file (first 50KB should be enough)
        headers = {'Range': 'bytes=0-51199'}
        response = requests.get(url, headers=headers)
        
        if response.status_code not in [200, 206]:
            print(f"Error: HTTP {response.status_code}")
            return None
        
        data = response.content
        bjsn_payload = find_bjsn_box(data)
        
        if bjsn_payload:
            try:
                json_str = bjsn_payload.decode('utf-8')
                bjsn_data = json.loads(json_str)
                return bjsn_data
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                print(f"Error parsing BJSN JSON: {e}")
                return None
        else:
            print("No BJSN box found")
            return None
            
    except Exception as e:
        print(f"Error extracting BJSN: {e}")
        return None

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 extract_bjsn.py <url>")
        sys.exit(1)
    
    url = sys.argv[1]
    bjsn_data = extract_bjsn_from_url(url)
    
    if bjsn_data:
        print("BJSN Data:")
        print(json.dumps(bjsn_data, indent=2))
    else:
        print("Failed to extract BJSN data")
