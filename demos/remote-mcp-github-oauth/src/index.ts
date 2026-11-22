import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { Octokit } from "octokit";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";

// Context from the auth process, encrypted and stored in the auth token.
type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

const ALLOWED_USERNAMES = new Set<string>([
	// Add GitHub usernames of users who should have access to the image generation tool
	// For example: 'yourusername', 'coworkerusername'
]);

function createServer() {
	const server = new McpServer({
		name: "Github OAuth Proxy Demo",
		version: "1.0.0",
	});
	const props = getMcpAuthContext()?.props as Props | undefined;

	server.registerTool(
		"add",
		{
			description: "Add two numbers the way only MCP can",
			inputSchema: z.object({ a: z.number(), b: z.number() }),
		},
		async ({ a, b }) => ({
			content: [{ text: String(a + b), type: "text" }],
		}),
	);

	if (props) {
		server.registerTool(
			"userInfoOctokit",
			{
				description: "Get user info from GitHub, via Octokit",
			},
			async () => {
				const octokit = new Octokit({ auth: props.accessToken });
				return {
					content: [
						{
							text: JSON.stringify(await octokit.rest.users.getAuthenticated()),
							type: "text",
						},
					],
				};
			},
		);
	}

	// Dynamically add tools based on the authenticated user's login.
	if (props && ALLOWED_USERNAMES.has(props.login)) {
		server.registerTool(
			"generateImage",
			{
				description:
					"Generate an image using the `flux-1-schnell` model. Works best with 8 steps.",
				inputSchema: z.object({
					prompt: z
						.string()
						.describe("A text description of the image you want to generate."),
					steps: z
						.number()
						.min(4)
						.max(8)
						.default(4)
						.describe(
							"The number of diffusion steps; higher values can improve quality but take longer. Must be between 4 and 8, inclusive.",
						),
				}),
			},
			async ({ prompt, steps }) => {
				const response = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
					prompt,
					steps,
				});

				return {
					content: [{ data: response.image!, mimeType: "image/jpeg", type: "image" }],
				};
			},
		);
	}

	if (props?.login.toLowerCase() === "coding-ty") {
  server.registerTool(
    "get_meta_accounts",
    {
      description: "Look up my Facebook Page and its linked Instagram account.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const settings = env as Env & {
        META_ACCESS_TOKEN?: string;
        META_PAGE_ID?: string;
        META_GRAPH_VERSION?: string;
      };
      const {
        META_ACCESS_TOKEN: token,
        META_PAGE_ID: pageId,
        META_GRAPH_VERSION: version,
      } = settings;

      if (!token || !pageId || !version ||
          !/^\d+$/.test(pageId) || !/^v\d+\.\d+$/.test(version)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Check the three Meta settings in Cloudflare." }],
        };
      }

      const url = new URL(`https://graph.facebook.com/${version}/${pageId}`);
      url.searchParams.set("fields", "id,name,instagram_business_account");

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
      });

      if (!response.ok) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Meta returned HTTP ${response.status}. Check the token and Page permissions.`,
          }],
        };
      }

      const page = await response.json<{
        id: string;
        name: string;
        instagram_business_account?: { id: string };
      }>();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            facebookPage: { id: page.id, name: page.name },
            linkedInstagramAccountId: page.instagram_business_account?.id ?? null,
          }),
        }],
      };
    },
  );
}
	return server;
}

const mcpHandler = createMcpHandler(createServer);
const apiHandler = {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

export default new OAuthProvider<Env>({
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
	// The URL MCP clients connect to. Every token is bound to it.
	resourceMetadata: { resource: env.MCP_RESOURCE },
});
