# Shadow Intern Server

A Node.js backend server for the Shadow Intern Chrome Extension, providing AI-powered Twitter/X reply generation with license-based access control.

## Overview

Shadow Intern Server is an Express.js API that:
- Generates contextual Twitter/X replies using OpenAI's GPT-4.1-mini
- Manages license keys with usage limits and tracking
- Supports multiple reply modes (One-Liner, Agree, Disagree, Funny, etc.)
- Provides humanized or neutral reply styles
- Tracks usage statistics and provides admin dashboard

## Features

- **License System**: SQLite-based license management with usage limits
- **AI Reply Generation**: OpenAI GPT-4.1-mini integration with customizable prompts
- **Multiple Modes**: 9 pre-configured reply modes (One-Liner, Agree, Disagree, Funny, Question, Quote, Answer, Congrats, Thanks)
- **Tone Control**: 4 tone options (neutral, degen, professional, toxic)
- **Humanization**: Optional human-like reply style with contractions and casual language
- **Length Control**: Prompt-level and post-generation character limits (50-500 chars)
- **Image Support**: Processes tweet images via OpenAI vision API
- **Usage Tracking**: Detailed logging of all API requests per license
- **Admin Dashboard**: Localhost-only admin endpoints for license management

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- OpenAI API key
- SQLite3 (via better-sqlite3)

## Installation

1. Clone the repository and navigate to the server directory:
```bash
cd xallower-server
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```env
OPENAI_API_KEY=your_openai_api_key_here
PORT=3001
```

## Configuration

### Environment Variables

- `OPENAI_API_KEY` (required): Your OpenAI API key
- `PORT` (optional): Server port, defaults to 3001

### Database

The server uses SQLite with WAL (Write-Ahead Logging) mode. The database file `shadow.db` is created automatically on first run.

**Default License Keys** (created automatically):
- `shadow-demo-key` - 1000 requests, active
- `shadow-test-key` - 100 requests, active
- `shadow-disabled-key` - 0 requests, inactive

## Running the Server

Start the server:
```bash
npm start
```

The server will start on `http://localhost:3001` (or your configured PORT).

## API Endpoints

### Public Endpoints

#### `POST /api/xallower-reply`
Unlicensed endpoint for testing (not recommended for production).

**Request Body:**
```json
{
  "mode": "one-liner",
  "tweetText": "Tweet content here",
  "imageUrls": ["https://example.com/image.jpg"],
  "settings": {
    "maxChars": 220,
    "tone": "neutral",
    "humanize": true,
    "modeId": "one-liner",
    "modeLabel": "☝️ One-Liner",
    "promptTemplate": "Drop one ruthless bar..."
  }
}
```

**Response:**
```json
{
  "reply": "Generated reply text"
}
```

#### `POST /license/validate`
Validate a license key.

**Request Body:**
```json
{
  "key": "shadow-demo-key"
}
```

**Response:**
```json
{
  "ok": true,
  "license": {
    "active": true,
    "limit": 1000,
    "usage": 42,
    "remaining": 958
  }
}
```

### Licensed Endpoints

#### `POST /shadow/generate`
Generate a reply (requires license key in header).

**Headers:**
```
X-License-Key: shadow-demo-key
```

**Request Body:** Same as `/api/xallower-reply`

**Response:** Same as `/api/xallower-reply`

**Note:** This endpoint increments usage count and logs the request.

### Admin Endpoints (Localhost Only)

All admin endpoints require requests from `localhost` (127.0.0.1, ::1, etc.).

#### `POST /admin/license/create`
Create a new license key.

**Request Body:**
```json
{
  "key": "shadow-custom-key",  // optional, auto-generated if omitted
  "limit": 500,                 // optional, defaults to 500
  "active": true                // optional, defaults to true
}
```

**Response:**
```json
{
  "key": "shadow-custom-key",
  "active": true,
  "limit": 500,
  "usage": 0,
  "remaining": 500,
  "created": 1234567890
}
```

#### `POST /admin/license/update`
Update an existing license key.

**Request Body:**
```json
{
  "key": "shadow-demo-key",
  "limit": 2000,    // optional
  "active": false   // optional
}
```

**Response:** Same format as create endpoint

#### `GET /admin/licenses`
Get all license keys with their status.

**Response:**
```json
[
  {
    "key": "shadow-demo-key",
    "active": true,
    "limit": 1000,
    "usage": 42,
    "remaining": 958,
    "lastRequest": 1234567890,
    "created": 1234567800
  }
]
```

#### `GET /admin/dashboard`
Get comprehensive server statistics.

**Response:**
```json
{
  "totalKeys": 3,
  "activeKeys": 2,
  "inactiveKeys": 1,
  "keys": [...],
  "serverStats": {
    "totalRequests": 150,
    "requestsPerKey": {
      "shadow-demo-key": 100,
      "shadow-test-key": 50
    },
    "requestsToday": 25,
    "lastActivity": 1234567890
  }
}
```

## Database Schema

### `licenses` Table
- `id` - INTEGER PRIMARY KEY
- `license_key` - TEXT UNIQUE (e.g., "shadow-xxxx-xxxx")
- `active` - INTEGER (0 or 1)
- `limit_total` - INTEGER (max requests)
- `usage` - INTEGER (current usage count)
- `created_at` - INTEGER (timestamp)
- `updated_at` - INTEGER (timestamp)
- `last_request_at` - INTEGER (timestamp, nullable)

### `usage_logs` Table
- `id` - INTEGER PRIMARY KEY
- `license_id` - INTEGER (foreign key to licenses)
- `endpoint` - TEXT (e.g., "/shadow/generate")
- `created_at` - INTEGER (timestamp)

## License System

### License Validation
A license is valid if:
1. The key exists in the database
2. `active = 1`
3. `usage < limit_total`

### Usage Tracking
- Each `/shadow/generate` request increments the license's usage count
- Usage is logged in `usage_logs` table
- Atomic transactions ensure accurate counting
- Requests are rejected if limit is reached

### License Key Format
Default format: `shadow-{8 hex characters}` (e.g., `shadow-a1b2c3d4`)

## Reply Generation

### Settings

**maxChars** (50-500, default: 220)
- Controls maximum reply length
- Enforced at prompt level and post-generation
- Token limit estimated as `ceil(maxChars / 4)`

**tone** (neutral | degen | professional | toxic)
- Adjusts reply style and energy level
- Integrated into system prompt

**humanize** (boolean, default: true)
- When enabled: Uses contractions, casual slang, minimal punctuation
- When disabled: More neutral AI style
- Affects system prompt construction

**promptTemplate**
- Custom instruction per mode
- Merged with tone and mode context

### Prompt Construction

1. System prompt is built based on `humanize` setting
2. User prompt includes:
   - Mode label and tone
   - Custom prompt template
   - Length constraint instruction
   - Tweet text and images
3. OpenAI API call with calculated `max_tokens`
4. Reply is trimmed if it exceeds `maxChars`

## Error Handling

### Common Errors

- `401 Unauthorized`: Missing or invalid license key
- `403 Forbidden`: License disabled or limit exceeded
- `400 Bad Request`: Invalid request body
- `500 Internal Server Error`: OpenAI API error or server issue

### Error Response Format
```json
{
  "error": "Error message here"
}
```

## Security

- Admin endpoints restricted to localhost only
- License keys required for production endpoints
- SQL injection protection via prepared statements
- CORS enabled for extension communication

## Development

### Project Structure
```
xallower-server/
├── server.js          # Main Express server
├── db.js              # SQLite database setup
├── package.json       # Dependencies
├── shadow.db          # SQLite database (auto-created)
└── .env               # Environment variables (not in repo)
```

### Dependencies
- `express` - Web framework
- `better-sqlite3` - SQLite database driver
- `openai` - OpenAI API client
- `cors` - CORS middleware
- `dotenv` - Environment variable management

## License

ISC

