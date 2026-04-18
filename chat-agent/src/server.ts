import { AIChatAgent } from '@cloudflare/ai-chat';
import { routeAgentRequest } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';
import { streamText, convertToModelMessages, pruneMessages, tool, stepCountIs } from 'ai';
import { z } from 'zod';

export class ChatAgent extends AIChatAgent {
	async onChatMessage() {
		const workersai = createWorkersAI({ binding: this.env.AI });

		const result = streamText({
			model: workersai('@cf/meta/llama-4-scout-17b-16e-instruct'),
			system: 'You are a helpful assistant. You can check the weather, ' + "get the user's timezone, and run calculations.",
			messages: pruneMessages({
				messages: await convertToModelMessages(this.messages),
				toolCalls: 'before-last-2-messages',
			}),
			tools: {
				// Server-side tool: runs automatically on the server
				getWeather: tool({
					description: 'Get the current weather for a city',
					inputSchema: z.object({
						city: z.string().describe('City name'),
					}),
					execute: async ({ city }) => {
						// Replace with a real weather API in production
						const conditions = ['sunny', 'cloudy', 'rainy'];
						const temp = Math.floor(Math.random() * 30) + 5;
						return {
							city,
							temperature: temp,
							condition: conditions[Math.floor(Math.random() * conditions.length)],
						};
					},
				}),

				// Client-side tool: no execute function — the browser handles it
				getUserTimezone: tool({
					description: "Get the user's timezone from their browser",
					inputSchema: z.object({}),
				}),

				// Approval tool: requires user confirmation before executing
				calculate: tool({
					description: 'Perform a math calculation with two numbers. ' + 'Requires user approval for large numbers.',
					inputSchema: z.object({
						a: z.number().describe('First number'),
						b: z.number().describe('Second number'),
						operator: z.enum(['+', '-', '*', '/', '%']).describe('Arithmetic operator'),
					}),
					needsApproval: async ({ a, b }) => Math.abs(a) > 1000 || Math.abs(b) > 1000,
					execute: async ({ a, b, operator }) => {
						const ops: Record<string, (x: number, y: number) => number> = {
							'+': (x, y) => x + y,
							'-': (x, y) => x - y,
							'*': (x, y) => x * y,
							'/': (x, y) => x / y,
							'%': (x, y) => x % y,
						};
						if (operator === '/' && b === 0) {
							return { error: 'Division by zero' };
						}
						return {
							expression: `${a} ${operator} ${b}`,
							result: ops[operator](a, b),
						};
					},
				}),
			},
			stopWhen: stepCountIs(5),
		});

		return result.toUIMessageStreamResponse();
	}
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);

		// Serve the chat UI at the root
		if (url.pathname === '/' || url.pathname === '/index.html') {
			const html = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>AI Chat Agent</title>
		<style>
			* { margin: 0; padding: 0; box-sizing: border-box; }
			body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; }
			.container { max-width: 900px; margin: 0 auto; padding: 20px; }
			.chat-box { background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 20px; height: 80vh; display: flex; flex-direction: column; }
			.messages { flex: 1; overflow-y: auto; border-bottom: 1px solid #e0e0e0; margin-bottom: 20px; padding-right: 10px; }
			.message { margin: 12px 0; padding: 12px; border-radius: 6px; }
			.message.user { background: #e3f2fd; text-align: right; }
			.message.assistant { background: #f5f5f5; }
			.form { display: flex; gap: 8px; }
			.form input { flex: 1; padding: 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
			.form button { padding: 12px 20px; background: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 500; }
			.form button:hover { background: #1565c0; }
			.form button:disabled { background: #ccc; cursor: not-allowed; }
			.tool-result { background: #fff3cd; border-left: 4px solid #ffc107; padding: 10px; margin: 8px 0; border-radius: 4px; font-size: 13px; }
			h1 { margin-bottom: 20px; color: #333; }
			.status { padding: 8px 12px; border-radius: 4px; font-size: 12px; margin-top: 8px; }
			.status.loading { background: #e3f2fd; color: #1976d2; }
		</style>
	</head>
	<body>
		<div class="container">
			<h1>⚡ AI Chat Agent</h1>
			<div class="chat-box">
				<div class="messages" id="messages"></div>
				<form class="form" id="chatForm">
					<input type="text" id="messageInput" placeholder="Ask me anything... (weather, timezone, math calculations)" autocomplete="off" />
					<button type="submit" id="sendBtn">Send</button>
				</form>
				<div id="status" class="status" style="display: none;"></div>
			</div>
		</div>

		<script>
			const messagesDiv = document.getElementById('messages');
			const input = document.getElementById('messageInput');
			const form = document.getElementById('chatForm');
			const sendBtn = document.getElementById('sendBtn');
			const statusDiv = document.getElementById('status');
			let isStreaming = false;

			form.addEventListener('submit', async (e) => {
				e.preventDefault();
				if (!input.value.trim() || isStreaming) return;

				isStreaming = true;
				sendBtn.disabled = true;
				statusDiv.textContent = 'Agent is thinking...';
				statusDiv.style.display = 'block';
				statusDiv.className = 'status loading';

				// Add user message
				const userMsg = document.createElement('div');
				userMsg.className = 'message user';
				userMsg.textContent = input.value;
				messagesDiv.appendChild(userMsg);
				messagesDiv.scrollTop = messagesDiv.scrollHeight;

				const userInput = input.value;
				input.value = '';

				try {
					// Call the agent endpoint
					const response = await fetch('/agent/chat', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ messages: [{ role: 'user', content: userInput }] }),
					});

					if (!response.ok) throw new Error(\`HTTP \${response.status}\`);

					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let assistantMsg = document.createElement('div');
					assistantMsg.className = 'message assistant';
					messagesDiv.appendChild(assistantMsg);

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						const chunk = decoder.decode(value);
						assistantMsg.textContent += chunk;
						messagesDiv.scrollTop = messagesDiv.scrollHeight;
					}
				} catch (err) {
					const errMsg = document.createElement('div');
					errMsg.className = 'message assistant';
					errMsg.textContent = \`Error: \${err.message}\`;
					messagesDiv.appendChild(errMsg);
				} finally {
					isStreaming = false;
					sendBtn.disabled = false;
					statusDiv.style.display = 'none';
				}
			});

			// Focus input on load
			input.focus();
		</script>
	</body>
</html>`;

			return new Response(html, {
				status: 200,
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		return (await routeAgentRequest(request, env)) || new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
