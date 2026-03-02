# SillyTavern Extension - AI Image Generator

A SillyTavern extension that integrates the PixAI Platform for AI image generation in roleplay chats. Features a cyberpunk neon theme.

## Features

- **Automatic/Manual Generation**: Detects `image###prompt###` patterns in AI responses to trigger generation
- **Preset System**: Select generation presets configured on the web platform (no complex parameter setup in the extension)
- **HUD Panel**: Floating cyberpunk panel showing account balance, generation queue with progress, and story status
- **Image Persistence**: Dual-layer storage — SillyTavern `extra` field (local) + server-side metadata (cross-browser restore)
- **Action Buttons**: Regenerate and variant buttons on each generated image
- **Story Share**: Collect conversation segments + images, generate AI-crafted HTML story pages via Claude API

## Installation

1. Open SillyTavern and navigate to Extensions
2. Install from URL or copy this folder to `SillyTavern/data/default-user/extensions/`
3. Enable the extension in SillyTavern settings

## Configuration

1. **Server URL**: Your PixAI Platform server address (e.g., `https://your-domain.com`)
2. **API Key**: Your `sk-xxx` API key from the platform's API Keys page
3. **Preset**: Select a generation preset configured on the web platform
4. Click "Test Connection" to verify

## Files

| File | Description |
|------|-------------|
| `manifest.json` | Extension manifest (display name, version, loading order) |
| `index.js` | Main logic: API calls, generation, polling, HUD, persistence, story share |
| `settings.html` | Settings panel UI (connection, presets, prompts, story share) |
| `style.css` | Cyberpunk neon theme with CSS variables and animations |

## How It Works

### Generation Flow
1. AI response contains `image###a girl in a garden###`
2. Extension extracts prompt, prepends global positive prompt, appends negative prompt
3. Submits async generation request via `POST /v1/images/generate-preset`
4. Polls `GET /v1/tasks/{task_id}` every 3 seconds until complete
5. Injects image into the message with action buttons
6. Saves image reference in message `extra` field for persistence

### Story Share Flow
1. User selects conversation range and clicks "Generate Story Page"
2. Extension collects text segments + image URLs
3. Submits to `POST /v1/stories` (async Claude API generation)
4. Polls `GET /v1/stories/{token}/status` for completion
5. Opens the generated page at `/shared/{token}`

## Requirements

- PixAI Platform server running with v1 API enabled
- Valid API key with sufficient points quota
- At least one generation preset configured on the web platform
- `ANTHROPIC_API_KEY` configured on the server (for story share feature)
