import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";

function findGodotProjectRoot(startDir: string): string | null {
    let currentDir = path.resolve(startDir);
    while (true) {
        if (fs.existsSync(path.join(currentDir, "project.godot"))) {
            return currentDir;
        }
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) break;
        currentDir = parentDir;
    }
    return null;
}

const server = new Server(
    { name: "godot-file-agent", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "create_godot_file",
                description: "Creates or overwrites a file (like .gd or .tscn) inside the active Godot project environment.",
                inputSchema: {
                    type: "object",
                    properties: {
                        relativePath: {
                            type: "string",
                            description: "The path from the project root (e.g., 'scripts/player.gd')."
                        },
                        content: {
                            type: "string",
                            description: "The complete text content to write to the file."
                        }
                    },
                    required: ["relativePath", "content"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "create_godot_file") {
        throw new Error(`Unsupported tool: ${request.params.name}`);
    }

    const { relativePath, content } = request.params.arguments as {
        relativePath: string;
        content: string;
    };

    const projectRoot = findGodotProjectRoot(process.cwd());
    if (!projectRoot) {
        return {
            content: [{ type: "text", text: "Error: No 'project.godot' found in parent tree." }],
            isError: true
        };
    }

    const targetPath = path.resolve(projectRoot, relativePath);
    if (!targetPath.startsWith(projectRoot)) {
        return {
            content: [{ type: "text", text: "Security Exception: Cannot write outside project root." }],
            isError: true
        };
    }

    try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, content, "utf8");
        return {
            content: [{ type: "text", text: `Success: res://${relativePath.replace(/\\/g, '/')}` }]
        };
    } catch (error: any) {
        return {
            content: [{ type: "text", text: `I/O Error: ${error.message}` }],
            isError: true
        };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
