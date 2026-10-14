/**
 * Genuine OpenCode tool definitions (description + JSON schema) captured from
 * the official client, ported from opencode2api
 * (internal/gateway/opencode_tools.json, v1.3.9).
 *
 * Why these exist: the Zen free tier validates the DEFINITION of every tool
 * whose name it recognises, and a synthesised stub — even one carrying the
 * right name — is rejected with 403 FreeTierError. "shell" is the name OpenCode
 * 2.x ships; the pre-2.x "bash" spelling is deliberately absent because a
 * synthesized bash definition does not match the one upstream expects.
 *
 * Gate condition 3 therefore needs genuine definitions, not stubs
 * (docs/FINDINGS.md §2.3).
 */

export interface ToolDefinition {
	readonly description: string
	readonly parameters: Readonly<Record<string, unknown>>
}

export const OPENCODE_TOOLS: Readonly<Record<string, ToolDefinition>> = {
	"shell": 	{
	  "description": "Execute a shell command and return its output. Commands run on Windows using powershell. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
	  "parameters": {
	    "additionalProperties": false,
	    "properties": {
	      "background": {
	        "description": "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
	        "type": "boolean"
	      },
	      "command": {
	        "description": "Shell command string to execute",
	        "type": "string"
	      },
	      "timeout": {
	        "description": "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
	        "minimum": 0,
	        "type": "integer"
	      },
	      "workdir": {
	        "description": "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
	        "type": "string"
	      }
	    },
	    "required": [
	      "command"
	    ],
	    "type": "object"
	  }
	},
	"read": 	{
	  "description": "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
	  "parameters": {
	    "additionalProperties": false,
	    "properties": {
	      "limit": {
	        "description": "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
	        "minimum": 0,
	        "type": "integer"
	      },
	      "offset": {
	        "description": "The line or directory entry to start reading from (1-based)",
	        "minimum": 0,
	        "type": "integer"
	      },
	      "path": {
	        "description": "File or directory to read",
	        "type": "string"
	      }
	    },
	    "required": [
	      "path"
	    ],
	    "type": "object"
	  }
	},
}

/** The minimal agent-shaped tool set the free tier validates. */
export const GATE_TOOL_NAMES: readonly string[] = ['shell', 'read']

/** Render one gate tool in the flat shape the host's context.tools expects. */
export function gateTool(name: string): { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> } {
	const definition = OPENCODE_TOOLS[name]
	if (!definition) throw new Error(`unknown gate tool: ${name}`)
	return { name, description: definition.description, parameters: definition.parameters as Record<string, unknown> }
}
