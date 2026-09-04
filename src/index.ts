import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as z from "zod/v4";
import { execAsync } from "./utils.ts";

const UID_SIDE_CAR_EXTENSIONS = new Set([
    ".gd",
    ".gdshader",
    ".shader",
    ".tscn",
    ".tres",
    ".res",
    ".material"
]);

// Godot 4.x canonical UID alphabet from ResourceUID::id_to_text().
// Note: 'z' and '9' are intentionally excluded for compatibility.
const GODOT_UID_ALPHABET = "abcdefghijklmnopqrstuvwxy012345678";
const GODOT_UID_BASE = BigInt(GODOT_UID_ALPHABET.length);

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

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
    const relative = path.relative(rootPath, targetPath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function shouldCreateUidSidecar(relativePath: string): boolean {
    const extension = path.extname(relativePath).toLowerCase();
    return UID_SIDE_CAR_EXTENSIONS.has(extension) && !relativePath.toLowerCase().endsWith(".uid");
}

function generateGodotUid(): string {
    // Match Godot 4.7 ResourceUID canonical text encoding.
    let value = randomBytes(8).readBigUInt64BE(0) & ((1n << 63n) - 1n);

    let encoded = "";
    do {
        const index = Number(value % GODOT_UID_BASE);
        encoded = GODOT_UID_ALPHABET[index] + encoded;
        value /= GODOT_UID_BASE;
    } while (value > 0n);

    return `uid://${encoded}`;
}

const server = new McpServer({
    name: "godot-file-agent",
    version: "1.0.0"
});

server.registerTool(
    "create_godot_file",
    {
        description: "Creates or overwrites a file (like .gd or .tscn) inside the active Godot project environment.",
        inputSchema: {
            relativePath: z.string().describe("The path from the project root (e.g., 'scripts/player.gd')."),
            content: z.string().describe("The complete text content to write to the file."),
            createUidFile: z.boolean().default(true).describe("If true, creates a companion .uid file for supported new files.")
        }
    },
    async ({ relativePath, content, createUidFile = true }) => {

        const projectRoot = findGodotProjectRoot(process.cwd());
        if (!projectRoot) {
            return {
                content: [{ type: "text", text: "Error: No 'project.godot' found in parent tree." }],
                isError: true
            };
        }

        const targetPath = path.resolve(projectRoot, relativePath);
        if (!isPathInsideRoot(projectRoot, targetPath)) {
            return {
                content: [{ type: "text", text: "Security Exception: Cannot write outside project root." }],
                isError: true
            };
        }

        try {
            const targetExisted = fs.existsSync(targetPath);
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, content, "utf8");

            let uidResult = "";
            const shouldWriteUid = createUidFile && !targetExisted && shouldCreateUidSidecar(relativePath);
            if (shouldWriteUid) {
                const uidPath = `${targetPath}.uid`;
                const uidExists = fs.existsSync(uidPath);

                if (!uidExists) {
                    fs.writeFileSync(uidPath, `${generateGodotUid()}\n`, "utf8");
                    uidResult = " (created .uid)";
                } else {
                    uidResult = " (.uid already existed)";
                }
            }

            return {
                content: [{ type: "text", text: `Success: res://${relativePath.replace(/\\/g, "/")}${uidResult}` }]
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Unknown I/O error";
            return {
                content: [{ type: "text", text: `I/O Error: ${message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "validate_godot_script",
    {
        description: "Runs Godot headlessly to parse a target GDScript file for compilation, syntax errors, and warning flags.",
        inputSchema: {
            relativePath: z.string().describe("The path to the GDScript file relative to the project root (e.g., 'scripts/player.gd')."),
            godotBinary: z.string().default("godot").describe("The command or absolute system path used to invoke the Godot executable.")
        }
    },
    async ({ relativePath, godotBinary = "godot" }) => {
        const projectRoot = findGodotProjectRoot(process.cwd());
        if (!projectRoot) {
            return {
                content: [{ type: "text", text: "Error: No 'project.godot' found in parent tree." }],
                isError: true
            };
        }

        const targetPath = path.resolve(projectRoot, relativePath);
        if (!isPathInsideRoot(projectRoot, targetPath)) {
            return {
                content: [{ type: "text", text: "Security Exception: Targeted script path is outside project root." }],
                isError: true
            };
        }

        if (!fs.existsSync(targetPath)) {
            return {
                content: [{ type: "text", text: `Error: Targeted script file does not exist at res://${relativePath}` }],
                isError: true
            };
        }

        // Godot checks scripts via: godot --headless --check-only --script res://path/to/script.gd
        const godotResourcePath = `res://${relativePath.replace(/\\/g, "/")}`;
        const command = `"${godotBinary}" --headless --check-only --script "${godotResourcePath}"`;

        try {
            // Run the compilation check inside the Godot project root folder
            const { stdout, stderr } = await execAsync(command, { cwd: projectRoot });

            // Combine output logs for evaluation
            const outputLog = (stdout + "\n" + stderr).trim();

            return {
                content: [{
                    type: "text",
                    text: `Validation Complete. Godot passed compilation without fatal exit codes.\n\nEngine Log:\n${outputLog || "No compilation errors or warnings flagged."}`
                }]
            };
        } catch (error: any) {
            // Godot exits with non-zero codes on script compilation errors
            const errorLog = (error.stdout + "\n" + error.stderr).trim() || error.message;
            return {
                content: [{
                    type: "text",
                    text: `Validation Failed: Compilation or syntax error detected by the engine!\n\nEngine Log:\n${errorLog}`
                }],
                isError: true
            };
        }
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});
