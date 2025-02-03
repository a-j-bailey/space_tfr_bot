# Space TFR Bot

A Cloudflare Worker that monitors and tweets about Space Operation Temporary Flight Restrictions (TFRs) from the FAA. The bot helps keep the space community informed about upcoming launch operations by automatically detecting and sharing new TFRs.

## Features

- 🔍 Automatically monitors FAA's TFR list
- 🚀 Filters for Space Operation TFRs
- 📊 Parses detailed information including:
  - Location
  - Start/End times
  - Coordinates
  - Altitude restrictions
  - NOTAM details
- 💾 Stores TFR history in Cloudflare KV
- 🐦 Posts new TFRs to Twitter
- 🌐 Provides API access to TFR data

## How It Works

1. Fetches the TFR list from `tfr.faa.gov/tfr2/list.html`
2. Filters for Space Operations TFRs
3. For each TFR:
   - Fetches detailed XML data
   - Parses coordinates and timing information
   - Checks if it's a new TFR
4. Stores new TFRs in Cloudflare KV storage
5. Posts new TFRs to X with formatted information