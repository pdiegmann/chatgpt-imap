# chatgpt-imap

An MCP server for working with IMAP mailboxes.

It exposes mailbox discovery, search, read, flag, move, and draft-creation tools over either stdio or an authenticated HTTP transport.

## What it does

- Connects to one IMAP account from environment variables
- Lists folders and detects special folders such as inbox, archive, drafts, sent, trash, and junk
- Searches mail with a small structured query DSL
- Fetches full message details, including optional body, headers, and attachments
- Marks messages as read or unread
- Moves messages between folders
- Creates draft messages and reply drafts by appending to the IMAP drafts folder

## Requirements

- Node.js 22+ recommended
- Access to an IMAP server and mailbox credentials
- Optional: SMTP settings if you want them stored in the connection config for future use

## Setup

1. Install dependencies.

```bash
npm install
```

2. Create a local environment file.

```bash
cp .env.example .env
```

3. Fill in the IMAP values in `.env`.

## Environment variables

The server loads a single connection automatically from environment variables.

| Variable | Required | Description |
| --- | --- | --- |
| `IMAP_ACCOUNT_ID` | no | Account identifier used in encoded `email_ref` values. Defaults to `default`. |
| `IMAP_HOST` | yes | IMAP host name. |
| `IMAP_PORT` | yes | IMAP port, usually `993`. |
| `IMAP_TLS` | no | Set to `false` to disable TLS. Defaults to `true`. |
| `IMAP_USERNAME` | yes | IMAP login user name. |
| `IMAP_PASSWORD` | yes | IMAP password or app password. |
| `SMTP_HOST` | no | Stored in the connection config, but not currently used by the implemented tools. |
| `SMTP_PORT` | no | Stored in the connection config, but not currently used by the implemented tools. |
| `SMTP_TLS` | no | Stored in the connection config, but not currently used by the implemented tools. |
| `LOG_LEVEL` | no | `DEBUG`, `INFO`, `WARN`, or `ERROR`. Defaults to `INFO`. |
| `MCP_TRANSPORT` | no | `stdio` or `http`. Defaults to `stdio`. |
| `MCP_AUTH_TOKEN` | required for HTTP | Bearer token required when `MCP_TRANSPORT=http`. |
| `MCP_PORT` | no | HTTP port when using `http`. Defaults to `3000`. |

## Running locally

### stdio transport

This is the default mode and is the right choice for local MCP clients that spawn the process.

```bash
npm run dev
```

For the built output:

```bash
npm run build
npm start
```

### HTTP transport

Set `MCP_TRANSPORT=http` and provide `MCP_AUTH_TOKEN`.

The server listens on `/mcp` and requires:

- `Authorization: Bearer <token>`

Example:

```bash
MCP_TRANSPORT=http MCP_AUTH_TOKEN=your-long-secret npm start
```

## Available tools

### `list_folders`

Lists mailbox folders and detects special folders.

Useful options:

- `include_stats`: add message and unseen counts
- `include_unselectable`: include container folders that cannot be selected

### `search_emails`

Searches messages using a structured query and returns summaries.

Useful options:

- `folders`: explicit folder paths to search
- `special_folders`: search only selected special-use folders
- `limit` and `offset`: pagination
- `sort`: currently supports date sorting
- `return_body_snippet`: accepted by the schema, but the current search implementation returns summaries with `snippet: null`

### `get_email`

Fetches one message by `email_ref`.

Useful options:

- `include_body_text`
- `include_body_html`
- `include_headers`
- `include_attachments`
- `max_body_chars`

### `set_email_flags`

Sets the `\Seen` flag on one or more messages.

- `seen: true` marks messages as read
- `seen: false` marks messages as unread

### `move_emails`

Moves one or more messages to a folder.

You can target either:

- `destination_folder`
- `destination_special_use`

If `create_if_missing` is enabled, the destination folder is created when possible.

### `create_draft`

Creates a new draft or a reply draft.

Important behavior:

- It does not send mail
- Drafts are appended to the IMAP drafts folder
- Reply drafts automatically derive recipients, subject, `In-Reply-To`, and `References` from the original message when possible
- `quote_original` defaults to `true`

## Search query DSL

`search_emails` accepts a recursive query tree.

### Fields

- `from`
- `to`
- `cc`
- `bcc`
- `subject`
- `body`
- `text_any`
- `date`

### Operators

- Text: `contains`, `equals`, `starts_with`, `ends_with`
- Date: `before`, `after`, `on`, `between`

### Boolean groups

- `AND`
- `OR`

### Example

```json
{
	"query": {
		"type": "group",
		"operator": "AND",
		"children": [
			{
				"type": "condition",
				"field": "from",
				"operator": "contains",
				"value": "github.com"
			},
			{
				"type": "condition",
				"field": "date",
				"operator": "after",
				"value": "2026-01-01"
			}
		]
	},
	"limit": 25,
	"offset": 0,
	"sort": {
		"field": "date",
		"direction": "desc"
	}
}
```

## Notes

- `email_ref` values are stable per account, folder, UID validity, and message UID
- The server currently auto-loads one account from environment variables; additional accounts would need to be registered in code before startup
- Logging redacts obvious secrets such as passwords and tokens

## Docker

The repository includes a Dockerfile.

```bash
docker build -t chatgpt-imap .
```

Run it with your environment variables, for example:

```bash
docker run --rm --env-file .env chatgpt-imap
```

If you want HTTP mode in the container, set `MCP_TRANSPORT=http` and `MCP_AUTH_TOKEN`.

## Development

- `npm run lint` — Biome lint
- `npm run check` — Biome check
- `npm run format` — format the codebase
- `npm run build` — compile TypeScript to `dist/`

## License

ISC