# ToolNest v3

Modular online tools platform.

## Features

- User registration with email verification (Resend)
- Single-device login (session token)
- Tool management via Admin
- Search & category filter
- Favorites
- Tool request form
- iframe tool embedding

## Setup

```bash
cp .env.example .env
# Edit .env with your keys

npm install
pm2 start server.js --name toolnest
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| PORT | Server port (default 3000) |
| SESSION_SECRET | Session encryption key |
| ADMIN_PASSWORD | Admin login password |
| RESEND_API_KEY | Resend API key |
| RESEND_FROM | From email address |

## Admin

Login at `/admin` with ADMIN_PASSWORD.

## Add Tools

In Admin, add tool with:
- Name
- Icon (emoji)
- Category
- URL (the tool's independent service URL)
- Description
