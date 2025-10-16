import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { McpServerConfig, McpConfiguration } from './types';
import { showMcpInstallationConfirmation } from './userDialogs';

/**
 * Result of an MCP server installation attempt
 */
type InstallResult = {
    cancelled: boolean;         // true = user cancelled, false = completed
    configModified: boolean;    // true = config needs to be written
};

/**
 * Handles MCP server installation and configuration
 */
export class McpInstaller {
    private outputChannel: vscode.OutputChannel;
    private mcpConfigPath: string;
    private context: vscode.ExtensionContext;

    constructor(outputChannel: vscode.OutputChannel, context: vscode.ExtensionContext) {
        this.outputChannel = outputChannel;
        this.context = context;
        // Get path to user's mcp.json file
        this.mcpConfigPath = this.getMcpConfigPath(context);
        
        // Log that we're using the correct VS Code path
        this.outputChannel.appendLine(`promptu: Using MCP config path: ${this.mcpConfigPath}`);
    }

    /**
     * Gets the VS Code User directory path using ExtensionContext
     * @param context VS Code extension context (required)
     */
    private getMcpConfigPath(context: vscode.ExtensionContext): string {

        try {
            // Use VS Code's globalStorageUri to find the User directory
            // globalStorageUri is typically: ~/.../Code/User/globalStorage/extension-id
            // We want: ~/.../Code/User/mcp.json
            const globalStoragePath = context.globalStorageUri.fsPath;
            const userDir = path.resolve(globalStoragePath, '..', '..');
            const mcpPath = path.join(userDir, 'mcp.json');
            
            this.outputChannel.appendLine(`promptu: Using VS Code API path: ${mcpPath}`);
            this.outputChannel.appendLine(`promptu: Derived from globalStorageUri: ${globalStoragePath}`);
            return mcpPath;
            
        } catch (error) {
            throw new Error(`Failed to determine MCP config path from VS Code API: ${error}`);
        }
    }

    /**
     * Installs and configures MCP servers from URI parameter
     * @param servers Array of MCP server configurations to install
     * @returns Promise<boolean> - true if all servers installed, false if user cancelled
     */
    async installServers(servers: McpServerConfig[]): Promise<boolean> {
        this.outputChannel.appendLine(`promptu: Installing ${servers.length} MCP server(s)...`);

        // Read mcp config, create a new one if it doesn't exist.
        let config = await this.readMcpConfig() || { servers: {}, inputs: [] };
        let needsConfigWrite = false;

        for (const server of servers) {
            try {    
                let result: InstallResult;
                
                if (server.nugetPackage) {
                    result = await this.installNuGetForServer(server, config);
                } else {
                    result = await this.installServerConfig(server, config);
                }

                if (result.cancelled) {
                    this.outputChannel.appendLine(`promptu: User cancelled installation of MCP server: ${server.name}`);
                    return false;
                }
                
                if (result.configModified) {
                    needsConfigWrite = true;
                }
            } catch (error) {
                const message = `Failed to install MCP server '${server.name}': ${error instanceof Error ? error.message : 'Unknown error'}`;
                this.outputChannel.appendLine(`promptu: ${message}`);
                throw new Error(message);
            }
        }

        // Write config once at the end if needed
        if (needsConfigWrite) {
            await this.writeMcpConfig(config);
        }

        return true;
    }

    /**
     * Installs a NuGet-based MCP server
     * @param server MCP server configuration with NuGet details
     * @param config MCP configuration object to modify
     * @returns Promise<InstallResult> - result with cancellation and config modification status
     */
    private async installNuGetForServer(server: McpServerConfig, config: McpConfiguration): Promise<InstallResult> {
        if (!server.nugetPackage) {
            throw new Error('NuGet server configuration requires nugetPackage property');
        }

        this.outputChannel.appendLine(`promptu: Installing NuGet package '${server.nugetPackage}' and '${server.version}'...`);

        // Check if package already meets requirements (only if version specified)
        if (server.version) {
            const installedVersion = await this.getNuGetPackageVersion(server.nugetPackage);
            if (installedVersion && this.isVersionSufficient(installedVersion, server.version)) {
                this.outputChannel.appendLine(`promptu: NuGet package '${server.nugetPackage}' already installed with sufficient version (${installedVersion})`);
                return { cancelled: false, configModified: false };
            }
            if (installedVersion) {
                this.outputChannel.appendLine(`promptu: NuGet package '${server.nugetPackage}' version ${installedVersion} insufficient (need ${server.version})`);
            }
        }

        // Ask user for permission with detailed information
        const shouldInstall = await showMcpInstallationConfirmation(server);
        if (!shouldInstall) {
            return { cancelled: true, configModified: false }; // User cancelled
        }

        // Install NuGet package
        await this.installNuGetGlobalTool(server);
        this.outputChannel.appendLine(`promptu: NuGet package installed successfully`);

        // Add to mcp.json config
        this.addServerToConfig(config, server);

        return { cancelled: false, configModified: true };
    }

    /**
     * Adds a server configuration to mcp.json (for config-only servers)
     * @param server MCP server configuration to add
     * @param config MCP configuration object to modify
     * @returns Promise<InstallResult> - result with cancellation and config modification status
     */
    private async installServerConfig(server: McpServerConfig, config: McpConfiguration): Promise<InstallResult> {
        // Check if already configured
        if (config !== null && server.name in config.servers) {
            this.outputChannel.appendLine(`promptu: Server '${server.name}' already configured in mcp.json`);
            return { cancelled: false, configModified: false }; // Already configured
        }

        // Ask user for permission with detailed information
        const shouldInstall = await showMcpInstallationConfirmation(server);
        if (!shouldInstall) {
            return { cancelled: true, configModified: false }; // User cancelled
        }

        // Add the server configuration
        this.addServerToConfig(config, server);
        return { cancelled: false, configModified: true };
    }

    /**
     * Helper function to add a server configuration to mcp configuration object
     * @param config - MCP configuration object to modify
     * @param server - MCP server configuration to add
     */
    private addServerToConfig(config: McpConfiguration, server: McpServerConfig): void {
        // Add the server configuration
        config.servers[server.name] = {
            type: server.type,
            ...(server.command && { command: server.command }),
            ...(server.args && { args: server.args }),
            ...(server.url && { url: server.url }),
            ...(server.env && { env: server.env })
        };

        this.outputChannel.appendLine(`promptu: Added ${server.name} to config (in memory)`);
    }

    /**
     * Compares two version strings to determine if installed version is sufficient
     * @param installed - Currently installed version
     * @param required - Required minimum version
     * @returns boolean - true if installed version meets requirements
     */
    private isVersionSufficient(installed: string, required: string): boolean {
        // Clean versions by removing pre-release and build metadata for main comparison
        const cleanInstalled = installed.split('-')[0].split('+')[0];
        const cleanRequired = required.split('-')[0].split('+')[0];
        
        // Split by dots and convert to numbers, handling invalid parts gracefully
        const installedParts = cleanInstalled.split('.').map(part => {
            const num = parseInt(part, 10);
            return isNaN(num) ? 0 : num;
        });
        const requiredParts = cleanRequired.split('.').map(part => {
            const num = parseInt(part, 10);
            return isNaN(num) ? 0 : num;
        });
        
        // Pad arrays to same length
        const maxLength = Math.max(installedParts.length, requiredParts.length);
        while (installedParts.length < maxLength) {
            installedParts.push(0);
        }
        while (requiredParts.length < maxLength) {
            requiredParts.push(0);
        }
        
        // Compare each part
        for (let i = 0; i < maxLength; i++) {
            if (installedParts[i] > requiredParts[i]) {
                return true; // Installed version is higher
            } else if (installedParts[i] < requiredParts[i]) {
                return false; // Installed version is lower
            }
            // Continue if equal
        }
        
        // If core versions are equal, handle pre-release comparison
        // Rule: 1.0.0 > 1.0.0-alpha (release > pre-release)
        const installedHasPrerelease = installed.includes('-');
        const requiredHasPrerelease = required.includes('-');
        
        if (!installedHasPrerelease && requiredHasPrerelease) {
            return true; // Release version satisfies pre-release requirement
        } else if (installedHasPrerelease && !requiredHasPrerelease) {
            return false; // Pre-release doesn't satisfy release requirement
        }
        
        return true; // Versions are equal or both pre-release
    }

    /**
     * Reads the current mcp.json configuration, returns null if file doesn't exist
     */
    async readMcpConfig(): Promise<McpConfiguration | null> {
        const configUri = vscode.Uri.file(this.mcpConfigPath);
        
        try {
            const fileData = await vscode.workspace.fs.readFile(configUri);
            const content = Buffer.from(fileData).toString('utf8');
            return JSON.parse(content);
        } catch (error) {
            if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
                return null; // File doesn't exist
            }
            throw error;
        }
    }

    /**
     * Gets MCP servers as an array of McpServerConfig objects
     */
    async getMcpServers(): Promise<McpServerConfig[]> {
        const config = await this.readMcpConfig();
        if (!config) {
            return []; // No config file means no servers
        }
        return Object.entries(config.servers || {}).map(([name, serverConfig]) => ({
            name,
            ...serverConfig
        }));
    }

    /**
     * Writes the mcp.json configuration
     */
    private async writeMcpConfig(config: McpConfiguration): Promise<void> {
        const configUri = vscode.Uri.file(this.mcpConfigPath);
        const dirUri = vscode.Uri.file(path.dirname(this.mcpConfigPath));
        
        // Ensure directory exists
        await vscode.workspace.fs.createDirectory(dirUri);

        const content = JSON.stringify(config, null, 2);
        const contentBuffer = Buffer.from(content, 'utf8');
        await vscode.workspace.fs.writeFile(configUri, contentBuffer);
    }

    /**
     * Executes a dotnet command and returns the result
     */
    private async executeDotnetCommand(args: string[]): Promise<{exitCode: number, stdout: string, stderr: string}> {
        const commandLine = `dotnet ${args.join(' ')}`;
        this.outputChannel.appendLine(`promptu: Running: ${commandLine}`);
        
        return new Promise((resolve) => {
            const process = spawn('dotnet', args, { shell: true });
            
            let stdout = '';
            let stderr = '';

            process.stdout?.on('data', (data) => stdout += data.toString());
            process.stderr?.on('data', (data) => stderr += data.toString());

            process.on('close', (exitCode) => {
                resolve({ exitCode: exitCode || 0, stdout, stderr });
            });

            process.on('error', (error) => {
                resolve({ exitCode: 1, stdout, stderr: error.message });
            });
        });
    }

    /**
     * Gets the installed version of a NuGet global tool
     * @param packageName - Name of the NuGet package
     * @returns Promise<string | null> - Version string if installed, null if not installed
     */
    private async getNuGetPackageVersion(packageName: string): Promise<string | null> {
        this.outputChannel.appendLine(`promptu: Checking version for NuGet package: ${packageName}`);
        
        try {
            const result = await this.executeDotnetCommand(['tool', 'list', '--global', packageName]);
            
            this.outputChannel.appendLine(`promptu: dotnet tool list stdout:\n${result.stdout}`);

            // Parse the output to check if package is installed. If package is NOT installed, there will be no package info line
            // Package Id                                    Version          Commands
            // -----------------------------------------------------------------------------------
            // my.example.package                            1.2.3-beta       example-command
            const lines = result.stdout.trim().split('\n');
            
            if (lines.length >= 3) {
                const dataLine = lines[2].trim();
                
                // Split by whitespace to get: [packageName, version, command]
                const parts = dataLine.split(/\s+/);
                
                if (parts.length >= 2) {
                    const version = parts[1];
                    this.outputChannel.appendLine(`promptu: Package ${packageName} is installed with version: ${version}`);
                    return version;
                }
            }
            
            this.outputChannel.appendLine(`promptu: Package ${packageName} is not installed, or version was not found.`);
            return null;
        } catch (error) {
            this.outputChannel.appendLine(`promptu: Error checking NuGet package version: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return null;
        }
    }

    /**
     * Installs a NuGet global tool
     * @param server - MCP server configuration with NuGet details
     */
    private async installNuGetGlobalTool(server: McpServerConfig): Promise<void> {
        if (!server.nugetPackage) {
            throw new Error('NuGet package name is required for installation');
        }

        const packageName = server.nugetPackage; // Store to help TypeScript understand it's defined

        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Installing ${server.name}...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Preparing dotnet tool install...' });

            // Build install command args
            const installArgs: string[] = ['tool', 'install', '--global', packageName];
            
            // Add custom feed if specified
            if (server.nugetFeed) {
                installArgs.push('--add-source', server.nugetFeed);
                // Add interactive flag for authentication to private feeds
                installArgs.push('--interactive');
                // Ignore failed sources to avoid errors from other configured feeds
                installArgs.push('--ignore-failed-sources');
                this.outputChannel.appendLine(`promptu: Using custom NuGet feed: ${server.nugetFeed}`);
            }
            
            // Add version if specified
            if (server.version) {
                installArgs.push('--version', server.version);
            }

            progress.report({ message: 'Running dotnet tool install...' });
            const result = await this.executeDotnetCommand(installArgs);

            if (result.exitCode !== 0) {
                throw new Error(`dotnet tool install failed: ${result.stderr}`);
            }

            this.outputChannel.appendLine(`promptu: NuGet package installed successfully`);
        });
    }

    /**
     * Parses MCP configuration from URI parameter
     */
    static parseMcpParameter(mcpParam: string): McpServerConfig[] {
        try {
            // Parse JSON configuration - must be valid JSON object or array
            const parsed = JSON.parse(decodeURIComponent(mcpParam));
            
            // Validate that parsed JSON is either an object or array
            if (typeof parsed !== 'object' || parsed === null) {
                throw new Error('Parsed JSON must be an object or array');
            }
            
            // Handle single server object
            if (!Array.isArray(parsed)) {
                return [parsed as McpServerConfig];
            }

            // Handle array of servers
            return parsed as McpServerConfig[];
            
        } catch (error) {
            throw new Error(`MCP parameter must be valid JSON (object or array). Example: {"name":"MyServer","type":"http","url":"https://myserver/mcp"}. Error: ${error instanceof Error ? error.message : 'Parse error'}`);
        }
    }
}